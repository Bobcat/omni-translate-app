"""Proxy to the translation-services image-translation API.

Submits an uploaded image to the ``translate_image`` task, polls the request
until it is terminal, and returns the rendered (translated) image bytes. The
service owns the OCR/grouping/translation/render pipeline; this is a thin
synchronous client over its ``/v1`` HTTP API so the frontend never talks to it
directly (no CORS, no exposed backend).

Synchronous on purpose: the route that calls this is a plain ``def`` so FastAPI
runs it in a threadpool — a translation takes seconds, which must not block the
event loop. Requests share the app's process-wide keep-alive pool.
"""
from __future__ import annotations

import json
import time
import uuid
from urllib.parse import quote

import httpx

from app.config import get_float, get_str
from app.translation_bridge import translation_language_code
from app.upstreams.http import get_upstream_http_client


SUPPORTED_IMAGE_MIME = {"image/jpeg", "image/png", "image/webp"}
REQUEST_ID_HEADER = "X-Image-Translation-Request-Id"

_TERMINAL_OK = "completed"
_TERMINAL_BAD = {"failed", "cancelled"}
# The lifecycle response keys artifacts by name without extension; "rendered" is the
# translated image (PNG). "output" is the side-by-side/original composite.
_RENDERED_ARTIFACT = "rendered"


class ImageTranslationError(RuntimeError):
    """A failure to obtain a translated image; ``status_code`` is the HTTP status
    the API route should surface to the client. ``code``/``details`` carry a
    machine-readable rejection (e.g. the service's source-character ceiling) so
    the route can return a structured detail the frontend can present."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 502,
        code: str = "",
        details: dict | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.details = dict(details or {})


def translate_image(
    *,
    operation_id: str,
    image_bytes: bytes,
    filename: str,
    content_type: str,
    source_language: str,
    target_language: str,
    render_options: dict | None = None,
    max_source_characters: int | None = None,
) -> tuple[bytes, str, str]:
    """Translate ``image_bytes`` and return ``(rendered_png_bytes, media_type, request_id)``.

    ``operation_id`` is the browser UUID for this explicit action and becomes the
    service ``request_id``. ``source_language``/``target_language`` are language names or ISO codes; they
    are normalised to the ISO codes the service expects. ``render_options`` carries
    the render flags for the first render; empty/unknown values are dropped so the
    service uses its own defaults for them. ``max_source_characters`` is the
    caller's per-image source-text ceiling, enforced by the service after OCR —
    over it the request fails with code ``SOURCE_CHARACTER_LIMIT_EXCEEDED``.
    Raises ``ImageTranslationError`` on an unsupported type, a service failure,
    or a timeout.
    """
    mime = (content_type or "").split(";")[0].strip().lower()
    if mime not in SUPPORTED_IMAGE_MIME:
        raise ImageTranslationError(f"unsupported image type: {mime or 'unknown'}", status_code=415)
    # "auto" is passed through: the service auto-detects the source language downstream.
    source_code = (
        "auto"
        if str(source_language or "").strip().lower() == "auto"
        else translation_language_code(source_language)
    )
    target_code = translation_language_code(target_language)
    if not source_code:
        raise ImageTranslationError("source language is required", status_code=400)
    if not target_code:
        raise ImageTranslationError("target language is required", status_code=400)

    request = {
        "request_id": str(operation_id),
        "task": "translate_image",
        "source_lang_code": source_code,
        "target_lang_code": target_code,
    }
    if max_source_characters is not None:
        request["max_source_characters"] = int(max_source_characters)
    for key in RENDER_OPTION_KEYS:
        value = str((render_options or {}).get(key) or "").strip()
        if value:
            request[key] = value
    request_json = json.dumps(request)
    request_id = _submit(
        request_json,
        image_bytes,
        filename or "image",
        mime,
        expected_request_id=operation_id,
    )
    _await_completion(request_id)
    data, media_type = _fetch_rendered(request_id)
    return data, media_type, request_id


# The render flags forwarded to the service's re-render (each optional; an omitted flag keeps
# the source run's value). The frontend owns their values; this bridge only passes them through.
RENDER_OPTION_KEYS = (
    "render_size_mode",
    "erase_fill_mode",
    "width_fit_mode",
    "size_metric_mode",
    "size_cohort_mode",
)


def retranslate_image(
    *,
    operation_id: str,
    source_request_id: str,
    target_language: str,
) -> tuple[bytes, str, str]:
    """Re-translate a prior image request and return ``(rendered_png_bytes, media_type, request_id)``."""
    source_id = str(source_request_id or "").strip()
    if not source_id:
        raise ImageTranslationError("source request_id is required", status_code=400)
    target_code = translation_language_code(target_language)
    if not target_code:
        raise ImageTranslationError("target language is required", status_code=400)

    request_id = _submit_reentry(
        source_id,
        "retranslate",
        {"request_id": str(operation_id), "target_lang_code": target_code},
        expected_request_id=operation_id,
    )
    _await_completion(request_id)
    data, media_type = _fetch_rendered(request_id)
    return data, media_type, request_id


def rerender_image(
    *,
    operation_id: str,
    source_request_id: str,
    render_options: dict,
) -> tuple[bytes, str, str]:
    """Re-render a prior image request with new render flags — reuses the cached translations,
    no OCR/grouping/LLM call. Returns ``(rendered_png_bytes, media_type, request_id)``. Only the
    known render flags are forwarded; unknown/empty values are dropped so the service keeps the
    source run's value for them."""
    source_id = str(source_request_id or "").strip()
    if not source_id:
        raise ImageTranslationError("source request_id is required", status_code=400)
    payload = {
        key: str(render_options[key]).strip()
        for key in RENDER_OPTION_KEYS
        if str(render_options.get(key) or "").strip()
    }
    payload["request_id"] = str(operation_id)
    request_id = _submit_reentry(
        source_id,
        "rerender",
        payload,
        expected_request_id=operation_id,
    )
    _await_completion(request_id)
    data, media_type = _fetch_rendered(request_id)
    return data, media_type, request_id


def _base_url() -> str:
    return get_str("image_translation.base_url", "http://127.0.0.1:8030").rstrip("/")


def _timeout_s() -> float:
    return get_float("image_translation.request_timeout_s", 120.0, min_value=1.0)


def _poll_interval_s() -> float:
    return get_float("image_translation.poll_interval_s", 0.5, min_value=0.05)


def _submit(
    request_json: str,
    image_bytes: bytes,
    filename: str,
    mime: str,
    *,
    expected_request_id: str,
) -> str:
    boundary = uuid.uuid4().hex
    body = _multipart_body(boundary, request_json, image_bytes, filename, mime)
    payload = _read_json(
        "POST",
        f"{_base_url()}/v1/requests",
        content=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    request_id = str(payload.get("request_id") or "").strip()
    if not request_id:
        raise ImageTranslationError("translation-services did not return a request_id")
    if request_id != str(expected_request_id):
        raise ImageTranslationError("translation-services returned an unexpected request_id")
    state = str(payload.get("state") or "")
    if state in _TERMINAL_BAD:
        raise _terminal_error(payload, state)
    return request_id


def _submit_reentry(
    source_request_id: str,
    subpath: str,
    payload: dict,
    *,
    expected_request_id: str,
) -> str:
    """Submit a re-entry request (retranslate or rerender) against a prior request_id and
    return the new request_id. Both endpoints take a JSON body and return a lifecycle envelope."""
    body = json.dumps(payload).encode("utf-8")
    safe_source_id = quote(source_request_id, safe="")
    response = _read_json(
        "POST",
        f"{_base_url()}/v1/requests/{safe_source_id}/{subpath}",
        content=body,
        headers={"Content-Type": "application/json"},
    )
    request_id = str(response.get("request_id") or "").strip()
    if not request_id:
        raise ImageTranslationError("translation-services did not return a request_id")
    if request_id != str(expected_request_id):
        raise ImageTranslationError("translation-services returned an unexpected request_id")
    state = str(response.get("state") or "")
    if state in _TERMINAL_BAD:
        raise _terminal_error(response, state)
    return request_id


def _await_completion(request_id: str) -> None:
    deadline = time.monotonic() + _timeout_s()
    interval = _poll_interval_s()
    url = f"{_base_url()}/v1/requests/{request_id}"
    while True:
        payload = _read_json("GET", url)
        state = str(payload.get("state") or "")
        if state == _TERMINAL_OK:
            return
        if state in _TERMINAL_BAD:
            raise _terminal_error(payload, state)
        if time.monotonic() >= deadline:
            raise ImageTranslationError("image translation timed out", status_code=504)
        time.sleep(interval)


def _fetch_rendered(request_id: str) -> tuple[bytes, str]:
    url = f"{_base_url()}/v1/requests/{request_id}/artifacts/{_RENDERED_ARTIFACT}"
    try:
        response = get_upstream_http_client().get(url, timeout=_timeout_s())
    except httpx.RequestError as exc:
        raise ImageTranslationError(f"translation-services unreachable: {exc}") from exc
    if response.is_error:
        raise ImageTranslationError(
            f"could not fetch rendered image: HTTP {response.status_code}"
        )
    data = response.content
    media_type = (response.headers.get("Content-Type") or "image/png").split(";")[0].strip()
    if not data:
        raise ImageTranslationError("rendered image was empty")
    return data, media_type


def _multipart_body(boundary: str, request_json: str, image_bytes: bytes, filename: str, mime: str) -> bytes:
    crlf = b"\r\n"
    bnd = boundary.encode("ascii")
    disposition = f'Content-Disposition: form-data; name="image_file"; filename="{_safe_filename(filename)}"'
    return b"".join(
        [
            b"--", bnd, crlf,
            b'Content-Disposition: form-data; name="request_json"', crlf,
            b"Content-Type: application/json", crlf, crlf,
            request_json.encode("utf-8"), crlf,
            b"--", bnd, crlf,
            disposition.encode("utf-8"), crlf,
            f"Content-Type: {mime}".encode("ascii"), crlf, crlf,
            image_bytes, crlf,
            b"--", bnd, b"--", crlf,
        ]
    )


def _safe_filename(filename: str) -> str:
    # Keep it on one header line; the service only uses the extension/stem.
    return str(filename or "image").replace("\r", " ").replace("\n", " ").replace('"', "'")


def _read_json(
    method: str,
    url: str,
    *,
    content: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> dict:
    try:
        response = get_upstream_http_client().request(
            method,
            url,
            content=content,
            headers=headers,
            timeout=_timeout_s(),
        )
    except httpx.RequestError as exc:
        raise ImageTranslationError(f"translation-services unreachable: {exc}") from exc
    if response.is_error:
        raise ImageTranslationError(
            _http_error_detail(response),
            status_code=response.status_code,
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise ImageTranslationError("invalid response from translation-services") from exc
    if not isinstance(payload, dict):
        raise ImageTranslationError("unexpected response from translation-services")
    return payload


def _terminal_error(payload: dict, state: str) -> ImageTranslationError:
    """The failure a terminal lifecycle record carries, mapped onto the route-facing
    error. A rejection with a stable code keeps that code + details; the source-
    character ceiling additionally gets a presentable message (the service's own
    message names raw field values, not a user-facing phrasing)."""
    error = payload.get("error")
    if not isinstance(error, dict):
        return ImageTranslationError(f"request {state}")
    code = str(error.get("code") or "")
    message = str(error.get("message") or code or f"request {state}")
    if code == "SOURCE_CHARACTER_LIMIT_EXCEEDED":
        details = error.get("details") if isinstance(error.get("details"), dict) else {}
        count = int(details.get("source_character_count") or 0)
        limit = int(details.get("max_source_characters") or 0)
        if count > 0 and limit > 0:
            message = (
                f"This image contains about {count:,} characters of text — "
                f"the per-image limit is {limit:,}."
            )
        return ImageTranslationError(message, status_code=422, code=code, details=details)
    return ImageTranslationError(message)


def _http_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
        detail = (
            payload.get("detail") or payload.get("message") or payload.get("code")
            if isinstance(payload, dict)
            else None
        )
        if isinstance(detail, dict):
            detail = detail.get("message") or detail.get("code")
        if detail:
            return f"translation-services error: {detail}"
    except Exception:
        pass
    return f"translation-services HTTP {response.status_code}"
