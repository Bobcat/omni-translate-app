"""Proxy to the translation-services image-translation API.

Submits an uploaded image to the ``translate_image`` task, polls the request
until it is terminal, and returns the rendered (translated) image bytes. The
service owns the OCR/grouping/translation/render pipeline; this is a thin
synchronous client over its ``/v1`` HTTP API so the frontend never talks to it
directly (no CORS, no exposed backend).

Synchronous on purpose: the route that calls this is a plain ``def`` so FastAPI
runs it in a threadpool — a translation takes seconds, which must not block the
event loop. Uses stdlib ``urllib`` to match the app's existing HTTP usage.
"""
from __future__ import annotations

import json
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from app.config import get_float, get_str
from app.translation_bridge import translation_language_code


SUPPORTED_IMAGE_MIME = {"image/jpeg", "image/png", "image/webp"}
REQUEST_ID_HEADER = "X-Image-Translation-Request-Id"

_TERMINAL_OK = "completed"
_TERMINAL_BAD = {"failed", "cancelled"}
# The lifecycle response keys artifacts by name without extension; "rendered" is the
# translated image (PNG). "output" is the side-by-side/original composite.
_RENDERED_ARTIFACT = "rendered"


class ImageTranslationError(RuntimeError):
    """A failure to obtain a translated image; ``status_code`` is the HTTP status
    the API route should surface to the client."""

    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def translate_image(
    *,
    image_bytes: bytes,
    filename: str,
    content_type: str,
    source_language: str,
    target_language: str,
) -> tuple[bytes, str, str]:
    """Translate ``image_bytes`` and return ``(rendered_png_bytes, media_type, request_id)``.

    ``source_language``/``target_language`` are language names or ISO codes; they
    are normalised to the ISO codes the service expects. Raises
    ``ImageTranslationError`` on an unsupported type, a service failure, or a
    timeout.
    """
    mime = (content_type or "").split(";")[0].strip().lower()
    if mime not in SUPPORTED_IMAGE_MIME:
        raise ImageTranslationError(f"unsupported image type: {mime or 'unknown'}", status_code=415)
    source_code = translation_language_code(source_language)
    target_code = translation_language_code(target_language)
    if not source_code:
        raise ImageTranslationError("source language is required", status_code=400)
    if not target_code:
        raise ImageTranslationError("target language is required", status_code=400)

    request_json = json.dumps(
        {
            "task": "translate_image",
            "source_lang_code": source_code,
            "target_lang_code": target_code,
        }
    )
    request_id = _submit(request_json, image_bytes, filename or "image", mime)
    _await_completion(request_id)
    data, media_type = _fetch_rendered(request_id)
    return data, media_type, request_id


def retranslate_image(
    *,
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

    request_id = _submit_retranslate(source_id, {"target_lang_code": target_code})
    _await_completion(request_id)
    data, media_type = _fetch_rendered(request_id)
    return data, media_type, request_id


def _base_url() -> str:
    return get_str("image_translation.base_url", "http://127.0.0.1:8030").rstrip("/")


def _timeout_s() -> float:
    return get_float("image_translation.request_timeout_s", 120.0, min_value=1.0)


def _poll_interval_s() -> float:
    return get_float("image_translation.poll_interval_s", 0.5, min_value=0.05)


def _submit(request_json: str, image_bytes: bytes, filename: str, mime: str) -> str:
    boundary = uuid.uuid4().hex
    body = _multipart_body(boundary, request_json, image_bytes, filename, mime)
    request = Request(
        f"{_base_url()}/v1/requests",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    payload = _read_json(request)
    request_id = str(payload.get("request_id") or "").strip()
    if not request_id:
        raise ImageTranslationError("translation-services did not return a request_id")
    state = str(payload.get("state") or "")
    if state in _TERMINAL_BAD:
        raise ImageTranslationError(_error_message(payload) or f"request {state}")
    return request_id


def _submit_retranslate(source_request_id: str, payload: dict) -> str:
    body = json.dumps(payload).encode("utf-8")
    safe_source_id = quote(source_request_id, safe="")
    request = Request(
        f"{_base_url()}/v1/requests/{safe_source_id}/retranslate",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    response = _read_json(request)
    request_id = str(response.get("request_id") or "").strip()
    if not request_id:
        raise ImageTranslationError("translation-services did not return a request_id")
    state = str(response.get("state") or "")
    if state in _TERMINAL_BAD:
        raise ImageTranslationError(_error_message(response) or f"request {state}")
    return request_id


def _await_completion(request_id: str) -> None:
    deadline = time.monotonic() + _timeout_s()
    interval = _poll_interval_s()
    url = f"{_base_url()}/v1/requests/{request_id}"
    while True:
        payload = _read_json(Request(url, method="GET"))
        state = str(payload.get("state") or "")
        if state == _TERMINAL_OK:
            return
        if state in _TERMINAL_BAD:
            raise ImageTranslationError(_error_message(payload) or f"request {state}")
        if time.monotonic() >= deadline:
            raise ImageTranslationError("image translation timed out", status_code=504)
        time.sleep(interval)


def _fetch_rendered(request_id: str) -> tuple[bytes, str]:
    url = f"{_base_url()}/v1/requests/{request_id}/artifacts/{_RENDERED_ARTIFACT}"
    try:
        with urlopen(Request(url, method="GET"), timeout=_timeout_s()) as response:
            data = response.read()
            media_type = (response.headers.get("Content-Type") or "image/png").split(";")[0].strip()
    except HTTPError as exc:
        raise ImageTranslationError(f"could not fetch rendered image: HTTP {exc.code}") from exc
    except URLError as exc:
        raise ImageTranslationError(f"translation-services unreachable: {exc.reason}") from exc
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


def _read_json(request: Request) -> dict:
    try:
        with urlopen(request, timeout=_timeout_s()) as response:
            raw = response.read()
    except HTTPError as exc:
        raise ImageTranslationError(_http_error_detail(exc)) from exc
    except URLError as exc:
        raise ImageTranslationError(f"translation-services unreachable: {exc.reason}") from exc
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ImageTranslationError("invalid response from translation-services") from exc
    if not isinstance(payload, dict):
        raise ImageTranslationError("unexpected response from translation-services")
    return payload


def _error_message(payload: dict) -> str:
    error = payload.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error.get("code") or "")
    return ""


def _http_error_detail(exc: HTTPError) -> str:
    try:
        payload = json.loads(exc.read().decode("utf-8"))
        detail = payload.get("detail") if isinstance(payload, dict) else None
        if isinstance(detail, dict):
            detail = detail.get("message") or detail.get("code")
        if detail:
            return f"translation-services error: {detail}"
    except Exception:
        pass
    return f"translation-services HTTP {exc.code}"
