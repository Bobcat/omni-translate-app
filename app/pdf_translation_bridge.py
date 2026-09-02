"""Proxy to the translation-services PDF-translation API.

Submits an uploaded PDF to the ``translate_pdf`` task and exposes the request
lifecycle (status poll, artifacts) to the desktop frontend, so the browser
never talks to the service directly (no CORS, no exposed backend). Same
upstream ``/v1`` HTTP API as the image-translation bridge; only the multipart
submit differs: a PDF goes up as ``document_file`` where images use
``image_file``.

Synchronous on purpose: the routes that call this are plain ``def`` so FastAPI
runs them in a threadpool. Requests share the app's process-wide keep-alive
pool.
"""
from __future__ import annotations

import json
import uuid
from typing import Any, Mapping
from urllib.parse import quote

import httpx

from app.config import get_float, get_str
from app.translation_bridge import translation_language_code
from app.upstreams.http import get_upstream_http_client


class PdfTranslationError(RuntimeError):
    """A failure to submit/poll/fetch a PDF translation; ``status_code`` is the
    HTTP status the API route should surface to the client."""

    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def prepare_pdf(
    *,
    document_bytes: bytes,
    filename: str,
    content_type: str,
    operation_id: str,
    render_options: Mapping[str, Any],
) -> dict:
    """Upload once and stop after authoritative PDF source measurement."""
    request_json = json.dumps(
        {
            "request_id": str(operation_id),
            "task": "translate_pdf",
            "priority": "normal",
            "source_lang_code": "auto",
            "quota_authorization_required": True,
            **dict(render_options),
        }
    )
    return _submit_multipart(
        request_json,
        document_bytes,
        filename or "document.pdf",
        content_type or "application/pdf",
    )


def authorize_pdf_request(
    request_id: str,
    *,
    counting_version: str,
    source_character_count: int,
    target_language: str,
) -> dict:
    """Authorize one measured PDF and lock the selected target language."""
    safe_id = quote(str(request_id or "").strip(), safe="")
    if not safe_id:
        raise PdfTranslationError("request_id is required", status_code=400)
    try:
        target_code = translation_language_code(target_language)
    except ValueError as exc:
        raise PdfTranslationError(str(exc), status_code=400) from exc
    if not target_code:
        raise PdfTranslationError("target language is required", status_code=400)
    return _read_json(
        "POST",
        f"{_base_url()}/v1/requests/{safe_id}/authorize",
        content=json.dumps(
            {
                "source_character_counting_version": str(counting_version),
                "source_character_count": int(source_character_count),
                "target_lang_code": target_code,
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        timeout=_short_timeout_s(),
    )


def get_pdf_request(request_id: str) -> dict:
    """Fetch the lifecycle envelope for ``request_id`` (client-side polling)."""
    safe_id = quote(str(request_id or "").strip(), safe="")
    if not safe_id:
        raise PdfTranslationError("request_id is required", status_code=400)
    return _read_json(
        "GET",
        f"{_base_url()}/v1/requests/{safe_id}",
        timeout=_short_timeout_s(),
    )


def cancel_pdf_request(request_id: str) -> dict:
    """Ask the service to cancel a running request; returns the lifecycle envelope."""
    safe_id = quote(str(request_id or "").strip(), safe="")
    if not safe_id:
        raise PdfTranslationError("request_id is required", status_code=400)
    return _read_json(
        "POST",
        f"{_base_url()}/v1/requests/{safe_id}/cancel",
        content=b"",
        timeout=_short_timeout_s(),
    )


def get_pdf_artifact(request_id: str, artifact_name: str) -> tuple[bytes, str]:
    """Fetch an artifact (e.g. the rendered PDF) and return ``(bytes, media_type)``."""
    safe_id = quote(str(request_id or "").strip(), safe="")
    safe_name = quote(str(artifact_name or "").strip(), safe="")
    if not safe_id or not safe_name:
        raise PdfTranslationError("request_id and artifact name are required", status_code=400)
    url = f"{_base_url()}/v1/requests/{safe_id}/artifacts/{safe_name}"
    try:
        response = get_upstream_http_client().get(url, timeout=_artifact_timeout_s())
    except httpx.RequestError as exc:
        raise PdfTranslationError(f"translation-services unreachable: {exc}") from exc
    if response.is_error:
        raise PdfTranslationError(
            _http_error_detail(response), status_code=response.status_code
        )
    data = response.content
    media_type = (response.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
    if not data:
        raise PdfTranslationError("artifact was empty")
    return data, media_type


def _base_url() -> str:
    return get_str("pdf_translation.base_url", "http://127.0.0.1:8030").rstrip("/")


def _submit_timeout_s() -> float:
    return get_float("pdf_translation.submit_timeout_s", 120.0, min_value=1.0)


def _short_timeout_s() -> float:
    return get_float("pdf_translation.poll_timeout_s", 10.0, min_value=1.0)


def _artifact_timeout_s() -> float:
    return get_float("pdf_translation.artifact_timeout_s", 60.0, min_value=1.0)


def _submit_multipart(request_json: str, document_bytes: bytes, filename: str, content_type: str) -> dict:
    boundary = uuid.uuid4().hex
    crlf = b"\r\n"
    bnd = boundary.encode("ascii")
    safe_filename = str(filename).replace("\r", " ").replace("\n", " ").replace('"', "'")
    safe_content_type = str(content_type).replace("\r", "").replace("\n", "")
    body = b"".join(
        [
            b"--", bnd, crlf,
            b'Content-Disposition: form-data; name="request_json"', crlf,
            b"Content-Type: application/json", crlf, crlf,
            request_json.encode("utf-8"), crlf,
            b"--", bnd, crlf,
            f'Content-Disposition: form-data; name="document_file"; filename="{safe_filename}"'.encode("utf-8"), crlf,
            f"Content-Type: {safe_content_type}".encode("utf-8"), crlf, crlf,
            document_bytes, crlf,
            b"--", bnd, b"--", crlf,
        ]
    )
    return _read_json(
        "POST",
        f"{_base_url()}/v1/requests",
        content=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        timeout=_submit_timeout_s(),
    )


def _read_json(
    method: str,
    url: str,
    *,
    timeout: float,
    content: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> dict:
    try:
        response = get_upstream_http_client().request(
            method,
            url,
            content=content,
            headers=headers,
            timeout=timeout,
        )
    except httpx.RequestError as exc:
        raise PdfTranslationError(f"translation-services unreachable: {exc}") from exc
    if response.is_error:
        raise PdfTranslationError(
            _http_error_detail(response), status_code=response.status_code
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise PdfTranslationError("invalid response from translation-services") from exc
    if not isinstance(payload, dict):
        raise PdfTranslationError("unexpected response from translation-services")
    return payload


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
