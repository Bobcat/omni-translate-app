from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from app.asr_pc_export import live_pc_events_to_text
from app.asr_pc_export import pc_export_filename
from app.config import get_int, get_str, optional_str, rooted_path
from app.image_translation_bridge import ImageTranslationError
from app.image_translation_bridge import REQUEST_ID_HEADER
from app.image_translation_bridge import rerender_image
from app.image_translation_bridge import retranslate_image
from app.image_translation_bridge import translate_image
from app.live_settings import default_live_settings
from app.live_settings import merge_live_settings
from app.live_settings import normalize_live_settings_delta
from app.pdf_translation_bridge import PdfTranslationError
from app.pdf_translation_bridge import cancel_pdf_request
from app.pdf_translation_bridge import get_pdf_artifact
from app.pdf_translation_bridge import get_pdf_request
from app.pdf_translation_bridge import submit_pdf
from app.protocol import PROTOCOL_VERSION
from app.saas_setup import resolve_request_entitlements
from app.sessions import SESSIONS
from app.translation_bridge import TranslationBridge
from app.translation_bridge import translation_language_code
from app.tts_bridge import artifact_path
from app.tts_bridge import tts_settings_payload
from app.tts_bridge import tts_settings_snapshot
from app.voice_library import discard_pending_stable_sample
from app.voice_library import generate_stable_sample
from app.voice_library import keep_pending_stable_sample
from app.voice_library import stable_voice_library_status

from realtime_translation_engine.types import LiveDispatchRequest
from realtime_translation_engine.types import TranslationOpportunity

from saas.fastapi_glue import set_identity_cookie


api_router = APIRouter(prefix="/api")


class CreateSessionRequest(BaseModel):
    side_a_language: str | None = None
    side_b_language: str | None = None
    live_settings: dict[str, Any] | None = None
    tts_settings: dict[str, Any] | None = None


class GenerateStableVoiceSampleRequest(BaseModel):
    language: str
    gender: str
    engine: str


class TextTranslationRequest(BaseModel):
    source_language: str
    target_language: str
    text: str
    final: bool = False


@api_router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@api_router.get("/config")
async def config() -> dict[str, Any]:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "audio_input": {
            "format": "pcm16le",
            "sample_rate_hz": get_int("live.audio.sample_rate_hz", 16000),
            "channels": get_int("live.audio.channels", 1),
        },
        "conversation": {
            "side_a_language": get_str("translation.source_language", "Dutch"),
            "side_b_language": get_str("translation.target_language", "English"),
        },
        "tts": tts_settings_payload(),
        "live_settings": default_live_settings(),
        "voice_library": {
            "stable": stable_voice_library_status(),
        },
        "auth": _auth_client_config(),
    }


def _auth_client_config() -> dict[str, Any]:
    """What the browser needs to run the external auth flow. The publishable key is
    public by design (guards nothing by itself). ``configured`` False keeps every
    account control hidden — dev without a provider stays anonymous-only."""
    issuer = optional_str("saas.auth.issuer")
    supabase_url = optional_str("saas.auth.supabase_url")
    if not supabase_url and issuer:
        supabase_url = issuer.removesuffix("/auth/v1")
    publishable_key = optional_str("saas.auth.publishable_key")
    return {
        "configured": bool(supabase_url and publishable_key),
        "supabase_url": supabase_url or "",
        "publishable_key": publishable_key or "",
    }


# Sync `def` on purpose: a translation takes seconds, so FastAPI runs this in a
# threadpool and the bridge's blocking poll never stalls the event loop.
@api_router.post("/image-translation")
def post_image_translation(
    request: Request,
    image: UploadFile = File(...),
    source_language: str = Form(...),
    target_language: str = Form(...),
    render_size_mode: str = Form(""),
    erase_fill_mode: str = Form(""),
    width_fit_mode: str = Form(""),
    size_metric_mode: str = Form(""),
    size_cohort_mode: str = Form(""),
) -> Response:
    content = image.file.read()
    if not content:
        raise HTTPException(status_code=400, detail="empty image upload")
    # The caller's plan gates the feature and sets the source-text ceiling the
    # service enforces after OCR (before any translation call). A just-created
    # anonymous identity rides back as a cookie on the image response.
    entitlements, identity_token = resolve_request_entitlements(request)
    entitlements.require_enabled("image_translation.enabled")
    max_characters = entitlements.get_int("image_translation.max_characters_per_job")
    try:
        data, media_type, request_id = translate_image(
            image_bytes=content,
            filename=image.filename or "image",
            content_type=image.content_type or "",
            source_language=source_language,
            target_language=target_language,
            render_options={
                "render_size_mode": render_size_mode,
                "erase_fill_mode": erase_fill_mode,
                "width_fit_mode": width_fit_mode,
                "size_metric_mode": size_metric_mode,
                "size_cohort_mode": size_cohort_mode,
            },
            max_source_characters=max_characters,
        )
    except ImageTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_image_error_detail(exc))
    response = Response(content=data, media_type=media_type, headers={REQUEST_ID_HEADER: request_id})
    if identity_token is not None:
        set_identity_cookie(request, response, identity_token)
    return response


def _image_error_detail(exc: ImageTranslationError) -> Any:
    """Structured detail when the bridge carries a machine-readable rejection code,
    the plain message otherwise (both frontends read ``detail.message`` or the
    string form)."""
    if not exc.code:
        return str(exc)
    return {"code": exc.code, "message": str(exc), "details": exc.details}


@api_router.post("/image-translation/{source_request_id}/retranslate")
def post_image_retranslation(
    source_request_id: str,
    target_language: str = Form(...),
) -> Response:
    try:
        data, media_type, request_id = retranslate_image(
            source_request_id=source_request_id,
            target_language=target_language,
        )
    except ImageTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    return Response(content=data, media_type=media_type, headers={REQUEST_ID_HEADER: request_id})


# Re-render a prior image request with new render flags — no re-translation (the service reuses
# the cached translations). Sync def for the same threadpool reason as the other image routes.
@api_router.post("/image-translation/{source_request_id}/rerender")
def post_image_rerender(
    source_request_id: str,
    render_size_mode: str = Form(""),
    erase_fill_mode: str = Form(""),
    width_fit_mode: str = Form(""),
    size_metric_mode: str = Form(""),
    size_cohort_mode: str = Form(""),
) -> Response:
    try:
        data, media_type, request_id = rerender_image(
            source_request_id=source_request_id,
            render_options={
                "render_size_mode": render_size_mode,
                "erase_fill_mode": erase_fill_mode,
                "width_fit_mode": width_fit_mode,
                "size_metric_mode": size_metric_mode,
                "size_cohort_mode": size_cohort_mode,
            },
        )
    except ImageTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    return Response(content=data, media_type=media_type, headers={REQUEST_ID_HEADER: request_id})


# PDF translation: unlike images, the submit returns a lifecycle envelope immediately
# and the desktop client polls it — a PDF can take minutes, so the route must not
# hold the connection. Sync defs for the same threadpool reason as the image routes.
@api_router.post("/pdf-translation/requests")
def post_pdf_translation_request(
    document_file: UploadFile = File(...),
    target_language: str = Form(...),
) -> dict[str, Any]:
    # Bounded read: never hold more than the limit in memory, and reject
    # oversized uploads without relying on a reverse-proxy limit. Same
    # config pattern as text_translation.max_chars.
    max_bytes = get_int("pdf_translation.max_upload_bytes", 25 * 1024 * 1024, min_value=1)
    content = document_file.file.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"document too large (max {max_bytes // (1024 * 1024)} MB)",
        )
    if not content:
        raise HTTPException(status_code=400, detail="empty document upload")
    try:
        return submit_pdf(
            document_bytes=content,
            filename=document_file.filename or "document.pdf",
            content_type=document_file.content_type or "application/pdf",
            target_language=target_language,
        )
    except PdfTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))


@api_router.get("/pdf-translation/requests/{request_id}")
def get_pdf_translation_request(request_id: str) -> dict[str, Any]:
    try:
        return get_pdf_request(request_id)
    except PdfTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))


@api_router.get("/pdf-translation/requests/{request_id}/artifacts/{artifact_name}")
def get_pdf_translation_artifact(request_id: str, artifact_name: str) -> Response:
    try:
        data, media_type = get_pdf_artifact(request_id, artifact_name)
    except PdfTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    return Response(
        content=data,
        media_type=media_type,
        # A completed run's artifact is immutable per (request_id, name), so
        # let the browser cache it: iframe reloads (view re-attach, reopen)
        # then skip the upstream re-download.
        headers={"Cache-Control": "private, max-age=86400, immutable"},
    )


@api_router.post("/pdf-translation/requests/{request_id}/cancel")
def post_pdf_translation_cancel(request_id: str) -> dict[str, Any]:
    try:
        return cancel_pdf_request(request_id)
    except PdfTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))


# One-shot text translation (typed/pasted text — the classic translator workflow).
# Stateless request/response: unlike voice sessions there is no event stream, the
# client re-sends the full current text and guards result freshness itself.
# Sync def for the same threadpool reason as the image routes: an LLM call takes
# seconds and must not hold the event loop.
@api_router.post("/text-translation")
def post_text_translation(payload: TextTranslationRequest) -> dict[str, Any]:
    text = str(payload.text or "")
    if not text.strip():
        raise HTTPException(status_code=400, detail="empty text")
    max_chars = get_int("text_translation.max_chars", 5000)
    if len(text) > max_chars:
        raise HTTPException(status_code=400, detail=f"text too long (max {max_chars} characters)")
    try:
        translation_language_code(payload.source_language)
        translation_language_code(payload.target_language)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    bridge = TranslationBridge(
        source_language=payload.source_language,
        target_language=payload.target_language,
    )
    # Same invocation shape as the live voice flow (runtime.py): the bridge only
    # reads the opportunity. commits_target gates the optional second pass.
    request = LiveDispatchRequest(
        request_id=1,
        committed_target_base_revision=0,
        opportunity=TranslationOpportunity(
            lane="commit",
            source_window=text,
            source_chunks_used=1,
            commits_target=bool(payload.final),
        ),
    )
    try:
        result = bridge.run(request)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"translation failed: {exc}")
    return {"translated_text": result.text, "model": result.model}


@api_router.post("/voice-library/stable")
async def post_stable_voice_sample(payload: GenerateStableVoiceSampleRequest) -> dict[str, Any]:
    tag = (payload.language or "").strip().lower()
    gender = (payload.gender or "").strip().lower()
    engine = (payload.engine or "").strip().lower()
    if not tag:
        raise HTTPException(status_code=400, detail="language_required")
    if not gender:
        raise HTTPException(status_code=400, detail="gender_required")
    if not engine:
        raise HTTPException(status_code=400, detail="engine_required")
    try:
        info = generate_stable_sample(tag, gender, engine)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"language": tag, "gender": gender, "engine": engine, "info": info}


@api_router.post("/voice-library/stable/{language}/{gender}/keep-pending")
async def post_keep_pending_stable_sample(language: str, gender: str) -> dict[str, Any]:
    tag = (language or "").strip().lower()
    gender_key = (gender or "").strip().lower()
    try:
        info = keep_pending_stable_sample(tag, gender_key)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"language": tag, "gender": gender_key, "info": info}


@api_router.post("/voice-library/stable/{language}/{gender}/discard-pending")
async def post_discard_pending_stable_sample(language: str, gender: str) -> dict[str, Any]:
    tag = (language or "").strip().lower()
    gender_key = (gender or "").strip().lower()
    try:
        info = discard_pending_stable_sample(tag, gender_key)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"language": tag, "gender": gender_key, "info": info}


@api_router.post("/sessions")
async def create_session(request: Request, payload: CreateSessionRequest) -> dict[str, Any]:
    side_a_language = str(payload.side_a_language or get_str("translation.source_language", "Dutch"))
    side_b_language = str(payload.side_b_language or get_str("translation.target_language", "English"))
    live_settings = default_live_settings()
    if payload.live_settings is not None:
        delta, errors = normalize_live_settings_delta(payload.live_settings, live_update=False)
        if errors:
            raise HTTPException(status_code=422, detail={"live_settings": errors})
        live_settings = merge_live_settings(live_settings, delta)
    tts_settings, tts_errors = tts_settings_snapshot(payload.tts_settings)
    if tts_errors:
        raise HTTPException(status_code=422, detail={"tts_settings": tts_errors})
    session = SESSIONS.create_session(
        side_a_language=side_a_language,
        side_b_language=side_b_language,
        live_settings=live_settings,
        tts_settings=tts_settings,
    )
    session_id = str(session["session_id"])
    ws_path = rooted_path(f"/ws/sessions/{session_id}")
    return {
        "protocol_version": PROTOCOL_VERSION,
        "session": session,
        "ws_path": ws_path,
        "ws_url": _ws_url_for_request(request, ws_path),
        "audio_input": {
            "format": "pcm16le",
            "sample_rate_hz": get_int("live.audio.sample_rate_hz", 16000),
            "channels": get_int("live.audio.channels", 1),
        },
    }


@api_router.get("/voice-library/stable/{language}/{gender}/audio.wav")
async def get_stable_voice_audio(language: str, gender: str) -> FileResponse:
    return _serve_stable_voice_audio(language, gender, filename="audio.wav")


@api_router.get("/voice-library/stable/{language}/{gender}/audio.pending.wav")
async def get_stable_voice_audio_pending(language: str, gender: str) -> FileResponse:
    return _serve_stable_voice_audio(language, gender, filename="audio.pending.wav")


def _serve_stable_voice_audio(language: str, gender: str, *, filename: str) -> FileResponse:
    from app.voice_library import STABLE_VOICE_GENDERS, STABLE_VOICE_LIBRARY_ROOT
    tag = (language or "").strip().lower()
    gender_key = (gender or "").strip().lower()
    allowed_chars = set("abcdefghijklmnopqrstuvwxyz-_")
    if not tag or any(ch not in allowed_chars for ch in tag):
        raise HTTPException(status_code=404, detail="Sample not found")
    if gender_key not in STABLE_VOICE_GENDERS:
        raise HTTPException(status_code=404, detail="Sample not found")
    path = (STABLE_VOICE_LIBRARY_ROOT / tag / gender_key / filename).resolve()
    if not str(path).startswith(str(STABLE_VOICE_LIBRARY_ROOT)) or not path.exists():
        raise HTTPException(status_code=404, detail="Sample not found")
    return FileResponse(
        path,
        media_type="audio/wav",
        filename=f"stable-{tag}-{gender_key}-{filename}",
        content_disposition_type="inline",
    )


@api_router.get("/sessions/{session_id}/tts/{artifact_id}")
async def get_tts_artifact(session_id: str, artifact_id: str) -> FileResponse:
    try:
        path = artifact_path(session_id, artifact_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="TTS artifact not found")
    if not path.exists():
        raise HTTPException(status_code=404, detail="TTS artifact not found")
    return FileResponse(path, media_type="audio/wav", filename=f"{artifact_id}.wav", content_disposition_type="inline")


@api_router.get("/sessions/{session_id}/transcript.pc")
async def get_session_pc_export(session_id: str) -> Response:
    try:
        events = SESSIONS.pc_events(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")
    text = live_pc_events_to_text(events)
    filename = pc_export_filename(session_id)
    return Response(
        content=text,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _ws_url_for_request(request: Request, ws_path: str) -> str:
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    if forwarded_proto in {"https", "wss"}:
        scheme = "wss"
    elif forwarded_proto in {"http", "ws"}:
        scheme = "ws"
    else:
        origin = (request.headers.get("origin") or "").strip()
        origin_scheme = urlparse(origin).scheme.lower() if origin else ""
        if origin_scheme == "https":
            scheme = "wss"
        elif origin_scheme == "http":
            scheme = "ws"
        else:
            scheme = "wss" if request.url.scheme == "https" else "ws"
    forwarded_host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    host = forwarded_host or request.headers.get("host") or request.url.netloc
    return f"{scheme}://{host}{ws_path}"
