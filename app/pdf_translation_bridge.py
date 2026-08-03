"""Proxy to the translation-services PDF-translation API.

Submits an uploaded PDF to the ``translate_pdf`` task and exposes the request
lifecycle (status poll, artifacts) to the desktop frontend, so the browser
never talks to the service directly (no CORS, no exposed backend). Same
upstream ``/v1`` HTTP API as the image-translation bridge; only the multipart
submit differs: a PDF goes up as ``document_file`` where images use
``image_file``.

Synchronous on purpose: the routes that call this are plain ``def`` so FastAPI
runs them in a threadpool. Uses stdlib ``urllib`` to match the app's existing
HTTP usage.
"""
from __future__ import annotations

import json
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from app.config import get_float, get_str
from app.translation_bridge import translation_language_code


class PdfTranslationError(RuntimeError):
    """A failure to submit/poll/fetch a PDF translation; ``status_code`` is the
    HTTP status the API route should surface to the client."""

    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def submit_pdf(
    *,
    document_bytes: bytes,
    filename: str,
    content_type: str,
    target_language: str,
    operation_id: str,
) -> dict:
    """Submit ``document_bytes`` for translation and return the lifecycle envelope.

    ``target_language`` is a language name or ISO code; it is normalised to the
    ISO code the service expects. The source is auto-detected downstream
    (fixed ``auto``). Raises ``PdfTranslationError`` on invalid input (status
    400) or a service failure (status 502).
    """
    try:
        target_code = translation_language_code(target_language)
    except ValueError as exc:
        raise PdfTranslationError(str(exc), status_code=400) from exc
    if not target_code:
        raise PdfTranslationError("target language is required", status_code=400)
    request_json = json.dumps(
        {
            "request_id": str(operation_id),
            "task": "translate_pdf",
            "priority": "normal",
            "source_lang_code": "auto",
            "target_lang_code": target_code,
        }
    )
    return _submit_multipart(request_json, document_bytes, filename or "document.pdf", content_type or "application/pdf")


def get_pdf_request(request_id: str) -> dict:
    """Fetch the lifecycle envelope for ``request_id`` (client-side polling)."""
    safe_id = quote(str(request_id or "").strip(), safe="")
    if not safe_id:
        raise PdfTranslationError("request_id is required", status_code=400)
    return _read_json(Request(f"{_base_url()}/v1/requests/{safe_id}", method="GET"), timeout=_short_timeout_s())


def cancel_pdf_request(request_id: str) -> dict:
    """Ask the service to cancel a running request; returns the lifecycle envelope."""
    safe_id = quote(str(request_id or "").strip(), safe="")
    if not safe_id:
        raise PdfTranslationError("request_id is required", status_code=400)
    return _read_json(
        Request(f"{_base_url()}/v1/requests/{safe_id}/cancel", data=b"", method="POST"),
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
        with urlopen(Request(url, method="GET"), timeout=_artifact_timeout_s()) as response:
            data = response.read()
            media_type = (response.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
    except HTTPError as exc:
        raise PdfTranslationError(
            _http_error_detail(exc), status_code=int(exc.code)
        ) from exc
    except URLError as exc:
        raise PdfTranslationError(f"translation-services unreachable: {exc.reason}") from exc
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
    request = Request(
        f"{_base_url()}/v1/requests",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    return _read_json(request, timeout=_submit_timeout_s())


def _read_json(request: Request, *, timeout: float) -> dict:
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except HTTPError as exc:
        raise PdfTranslationError(
            _http_error_detail(exc), status_code=int(exc.code)
        ) from exc
    except URLError as exc:
        raise PdfTranslationError(f"translation-services unreachable: {exc.reason}") from exc
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise PdfTranslationError("invalid response from translation-services") from exc
    if not isinstance(payload, dict):
        raise PdfTranslationError("unexpected response from translation-services")
    return payload


def _http_error_detail(exc: HTTPError) -> str:
    try:
        payload = json.loads(exc.read().decode("utf-8"))
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
    return f"translation-services HTTP {exc.code}"
