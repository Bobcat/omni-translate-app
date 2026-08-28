from __future__ import annotations

from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from pydantic import ConfigDict

from app.asr_pc_export import live_pc_events_to_text
from app.asr_pc_export import pc_export_filename
from app.config import get_int, get_str, optional_str, rooted_path
from app.image_admission import admit_image_operation
from app.image_admission import read_image_upload
from app.image_admission import validate_image_upload
from app.image_ownership import record_image_request_owner
from app.image_ownership import require_image_request_owner
from app.image_quota import handle_image_operation_lifecycle
from app.image_quota import register_image_quota_operation
from app.image_quota import reserve_image_job
from app.image_translation_bridge import cancel_image_request
from app.image_translation_bridge import get_image_artifact
from app.image_translation_bridge import get_image_request
from app.image_translation_bridge import ImageTranslationError
from app.image_translation_bridge import REQUEST_ID_HEADER
from app.image_translation_bridge import rerender_image
from app.image_translation_bridge import retranslate_image
from app.image_translation_bridge import translate_image
from app.live_settings import default_live_settings
from app.live_settings import merge_live_settings
from app.live_settings import normalize_live_settings_delta
from app.operation_ids import normalize_operation_id
from app.operation_ids import operation_payload_hash
from app.pdf_quota import finalize_pdf_reservation
from app.pdf_quota import attach_pdf_preview
from app.pdf_quota import require_pdf_request_owner
from app.pdf_quota import submit_pdf_with_quota
from app.pdf_ownership import record_pdf_rerender_owner
from app.pdf_render_options import PdfRenderOptions
from app.pdf_translation_bridge import PdfTranslationError
from app.pdf_translation_bridge import cancel_pdf_request
from app.pdf_translation_bridge import get_pdf_artifact
from app.pdf_translation_bridge import get_pdf_request
from app.pdf_translation_bridge import rerender_pdf_request
from app.protocol import PROTOCOL_VERSION
from app.saas_setup import resolve_request_context
from app.saas_setup import tts_fairness_key_for_principal
from app.sessions import SESSIONS
from app.text_translation_policy import admit_text_translation
from app.text_translation_policy import success_cache as text_translation_success_cache
from app.text_translation_policy import text_translation_payload_hash
from app.translation_bridge import TranslationBridge
from app.translation_bridge import TranslationServicesError
from app.translation_bridge import translation_language_code
from app.tts_bridge import artifact_path
from app.tts_bridge import tts_settings_payload
from app.tts_bridge import tts_settings_snapshot
from app.tts_bridge import tts_supports_voice_cloning
from app.voice.cloning import normalize_voice_cloning_settings
from app.voice_library import discard_pending_stable_sample
from app.voice_library import generate_stable_sample
from app.voice_library import keep_pending_stable_sample
from app.voice_library import stable_voice_library_status

api_router = APIRouter(prefix="/api")


class CreateSessionRequest(BaseModel):
    side_a_language: str | None = None
    side_b_language: str | None = None
    live_settings: dict[str, Any] | None = None
    tts_settings: dict[str, Any] | None = None
    voice_cloning: dict[str, Any] | None = None


class GenerateStableVoiceSampleRequest(BaseModel):
    language: str
    gender: str
    engine: str


class TextTranslationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_language: str
    target_language: str
    text: str


@api_router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@api_router.get("/config")
async def config() -> dict[str, Any]:
    account_plan = get_str("saas.auth.user_plan", "free")
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
        "pdf_translation": {
            "account_plan": {
                "pages_per_period": get_int(
                    f"saas.plans.{account_plan}.pdf_translation.pages_per_period"
                ),
                "max_pages_per_job": get_int(
                    f"saas.plans.{account_plan}.pdf_translation.max_pages_per_job"
                ),
            },
        },
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
    google_client_id = optional_str("saas.auth.google_client_id")
    return {
        "configured": bool(supabase_url and publishable_key and google_client_id),
        "supabase_url": supabase_url or "",
        "publishable_key": publishable_key or "",
        "google_client_id": google_client_id or "",
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
    operation_id: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Response:
    operation_id = normalize_operation_id(operation_id)
    # Resolve before validation so a rejected first anonymous request receives
    # a durable identity cookie and cannot reset its rate window on every try.
    principal, entitlements, _ = resolve_request_context(request)
    entitlements.require_enabled("image_translation.enabled")
    content, mime = read_image_upload(
        image.file,
        content_type=image.content_type or "",
        entitlements=entitlements,
    )
    max_characters = entitlements.get_int("image_translation.max_characters_per_job")
    render_options = {
        "render_size_mode": render_size_mode,
        "erase_fill_mode": erase_fill_mode,
        "width_fit_mode": width_fit_mode,
        "size_metric_mode": size_metric_mode,
        "size_cohort_mode": size_cohort_mode,
    }
    payload_hash = operation_payload_hash(
        "image_translation",
        content=content,
        parameters={
            "content_type": mime,
            "source_language": _image_language_hash_value(source_language, allow_auto=True),
            "target_language": _image_language_hash_value(target_language),
            **_image_render_hash_values(render_options),
        },
    )
    try:
        record_image_request_owner(principal, operation_id, payload_hash)
        with admit_image_operation(principal, entitlements, operation_id):
            validate_image_upload(content, declared_mime=mime, entitlements=entitlements)
            reserve_image_job(
                principal,
                entitlements,
                operation_id,
                action="translate",
            )
            quota_authorization_required = register_image_quota_operation(
                principal,
                entitlements,
                operation_id,
            )
            data, media_type, request_id = translate_image(
                operation_id=operation_id,
                image_bytes=content,
                filename=image.filename or "image",
                content_type=mime,
                source_language=source_language,
                target_language=target_language,
                render_options=render_options,
                max_source_characters=max_characters,
                quota_authorization_required=quota_authorization_required,
                lifecycle_handler=lambda envelope: handle_image_operation_lifecycle(
                    operation_id,
                    envelope,
                    raise_quota_errors=True,
                ),
            )
    except ImageTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_image_error_detail(exc))
    return Response(content=data, media_type=media_type, headers={REQUEST_ID_HEADER: request_id})


def _image_error_detail(exc: ImageTranslationError) -> Any:
    """Structured detail when the bridge carries a machine-readable rejection code,
    the plain message otherwise (both frontends read ``detail.message`` or the
    string form)."""
    if not exc.code:
        return str(exc)
    return {"code": exc.code, "message": str(exc), "details": exc.details}


def _image_language_hash_value(value: str, *, allow_auto: bool = False) -> str:
    raw = str(value or "").strip()
    if allow_auto and raw.lower() == "auto":
        return "auto"
    return translation_language_code(raw) or raw.casefold()


def _image_render_hash_values(render_options: dict[str, str]) -> dict[str, str]:
    return {
        key: str(value).strip()
        for key, value in render_options.items()
        if str(value or "").strip()
    }


@api_router.post("/image-translation/{source_request_id}/retranslate")
def post_image_retranslation(
    request: Request,
    source_request_id: str,
    target_language: str = Form(...),
    operation_id: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Response:
    operation_id = normalize_operation_id(operation_id)
    principal, entitlements, _ = resolve_request_context(request)
    entitlements.require_enabled("image_translation.enabled")
    require_image_request_owner(principal, source_request_id)
    payload_hash = operation_payload_hash(
        "image_retranslation",
        parameters={
            "source_request_id": str(source_request_id),
            "target_language": _image_language_hash_value(target_language),
        },
    )
    try:
        record_image_request_owner(principal, operation_id, payload_hash)
        with admit_image_operation(principal, entitlements, operation_id):
            reserve_image_job(
                principal,
                entitlements,
                operation_id,
                action="retranslate",
            )
            data, media_type, request_id = retranslate_image(
                operation_id=operation_id,
                source_request_id=source_request_id,
                target_language=target_language,
                lifecycle_handler=lambda envelope: handle_image_operation_lifecycle(
                    operation_id,
                    envelope,
                ),
            )
    except ImageTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    return Response(content=data, media_type=media_type, headers={REQUEST_ID_HEADER: request_id})


# Re-render a prior image request with new render flags — no re-translation (the service reuses
# the cached translations). Sync def for the same threadpool reason as the other image routes.
@api_router.post("/image-translation/{source_request_id}/rerender")
def post_image_rerender(
    request: Request,
    source_request_id: str,
    render_size_mode: str = Form(""),
    erase_fill_mode: str = Form(""),
    width_fit_mode: str = Form(""),
    size_metric_mode: str = Form(""),
    size_cohort_mode: str = Form(""),
    operation_id: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Response:
    operation_id = normalize_operation_id(operation_id)
    principal, entitlements, _ = resolve_request_context(request)
    entitlements.require_enabled("image_translation.enabled")
    require_image_request_owner(principal, source_request_id)
    render_options = {
        "render_size_mode": render_size_mode,
        "erase_fill_mode": erase_fill_mode,
        "width_fit_mode": width_fit_mode,
        "size_metric_mode": size_metric_mode,
        "size_cohort_mode": size_cohort_mode,
    }
    payload_hash = operation_payload_hash(
        "image_rerender",
        parameters={
            "source_request_id": str(source_request_id),
            **_image_render_hash_values(render_options),
        },
    )
    try:
        record_image_request_owner(principal, operation_id, payload_hash)
        with admit_image_operation(principal, entitlements, operation_id):
            data, media_type, request_id = rerender_image(
                operation_id=operation_id,
                source_request_id=source_request_id,
                render_options=render_options,
            )
    except ImageTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    return Response(content=data, media_type=media_type, headers={REQUEST_ID_HEADER: request_id})


@api_router.get("/image-translation/requests/{operation_id}")
def get_image_translation_request(request: Request, operation_id: str) -> dict[str, Any]:
    operation_id = normalize_operation_id(operation_id)
    principal, _, _ = resolve_request_context(request)
    require_image_request_owner(principal, operation_id)
    try:
        envelope = get_image_request(operation_id)
        handle_image_operation_lifecycle(operation_id, envelope)
        return envelope
    except ImageTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_image_error_detail(exc))


@api_router.get("/image-translation/requests/{operation_id}/artifact")
def get_image_translation_artifact(request: Request, operation_id: str) -> Response:
    operation_id = normalize_operation_id(operation_id)
    principal, _, _ = resolve_request_context(request)
    require_image_request_owner(principal, operation_id)
    try:
        data, media_type = get_image_artifact(operation_id)
    except ImageTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_image_error_detail(exc))
    return Response(
        content=data,
        media_type=media_type,
        headers={"Cache-Control": "private, no-store"},
    )


@api_router.post("/image-translation/requests/{operation_id}/cancel")
def post_image_translation_cancel(request: Request, operation_id: str) -> dict[str, Any]:
    operation_id = normalize_operation_id(operation_id)
    principal, _, _ = resolve_request_context(request)
    require_image_request_owner(principal, operation_id)
    try:
        envelope = cancel_image_request(operation_id)
        handle_image_operation_lifecycle(operation_id, envelope)
        return envelope
    except ImageTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_image_error_detail(exc))


# PDF translation: unlike images, the submit returns a lifecycle envelope immediately
# and the desktop client polls it — a PDF can take minutes, so the route must not
# hold the connection. Sync defs for the same threadpool reason as the image routes.
# The caller's plan gates the feature and its pages are reserved before the
# upstream job starts (app/pdf_quota.py); the poll and cancel routes settle
# that reservation when the job reaches a terminal state.
@api_router.post("/pdf-translation/requests")
def post_pdf_translation_request(
    request: Request,
    document_file: UploadFile = File(...),
    target_language: str = Form(...),
    page_layout_mode: Literal["fit", "typeset"] = Form("typeset"),
    page_scale: float = Form(0.9, ge=0.5, le=1.0),
    render_size_mode: Literal["min", "median"] = Form("median"),
    erase_fill_mode: Literal["flat", "inpaint"] = Form("inpaint"),
    width_fit_mode: Literal["footprint", "extend_to_margin"] = Form("footprint"),
    size_metric_mode: Literal["extent", "band", "fill"] = Form("extent"),
    size_cohort_mode: Literal["off", "vlm"] = Form("vlm"),
    pdf_structure_mode: Literal["source_only", "always"] = Form("source_only"),
    operation_id: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    operation_id = normalize_operation_id(operation_id)
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
    render_options = PdfRenderOptions(
        page_layout_mode=page_layout_mode,
        page_scale=page_scale,
        render_size_mode=render_size_mode,
        erase_fill_mode=erase_fill_mode,
        width_fit_mode=width_fit_mode,
        size_metric_mode=size_metric_mode,
        size_cohort_mode=size_cohort_mode,
        pdf_structure_mode=pdf_structure_mode,
    )
    try:
        envelope, _ = submit_pdf_with_quota(
            request,
            document_bytes=content,
            filename=document_file.filename or "document.pdf",
            content_type=document_file.content_type or "application/pdf",
            target_language=target_language,
            operation_id=operation_id,
            render_options=render_options.model_dump(),
        )
    except PdfTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    return envelope


@api_router.post("/pdf-translation/requests/{source_request_id}/rerender")
def post_pdf_translation_rerender(
    request: Request,
    source_request_id: str,
    render_options: PdfRenderOptions,
    operation_id: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    operation_id = normalize_operation_id(operation_id)
    source_event = require_pdf_request_owner(request, source_request_id)
    principal, entitlements, _ = resolve_request_context(request)
    entitlements.require_enabled("pdf_translation.enabled")
    payload = render_options.model_dump()
    payload_hash = operation_payload_hash(
        "pdf_rerender",
        parameters={
            "source_request_id": str(source_request_id),
            **{key: str(value) for key, value in payload.items()},
        },
    )
    record_pdf_rerender_owner(principal, operation_id, payload_hash)
    try:
        envelope = rerender_pdf_request(
            source_request_id,
            operation_id=operation_id,
            render_options=payload,
        )
    except PdfTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    if str(envelope.get("request_id") or "") != operation_id:
        raise HTTPException(
            status_code=502,
            detail="translation-services returned an unexpected request_id",
        )
    return attach_pdf_preview(envelope, source_event)


@api_router.get("/pdf-translation/requests/{request_id}")
def get_pdf_translation_request(request: Request, request_id: str) -> dict[str, Any]:
    event = require_pdf_request_owner(request, request_id)
    try:
        envelope = get_pdf_request(request_id)
    except PdfTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    finalize_pdf_reservation(envelope)
    return attach_pdf_preview(envelope, event)


@api_router.get("/pdf-translation/requests/{request_id}/artifacts/{artifact_name}")
def get_pdf_translation_artifact(request: Request, request_id: str, artifact_name: str) -> Response:
    require_pdf_request_owner(request, request_id)
    try:
        data, media_type = get_pdf_artifact(request_id, artifact_name)
    except PdfTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    return Response(
        content=data,
        media_type=media_type,
        # Do not let one browser account reuse another account's authenticated
        # artifact response from its private HTTP cache after an account switch.
        headers={"Cache-Control": "private, no-store"},
    )


@api_router.post("/pdf-translation/requests/{request_id}/cancel")
def post_pdf_translation_cancel(request: Request, request_id: str) -> dict[str, Any]:
    event = require_pdf_request_owner(request, request_id)
    try:
        envelope = cancel_pdf_request(request_id)
    except PdfTranslationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    finalize_pdf_reservation(envelope)
    return attach_pdf_preview(envelope, event)


# One-shot text translation (typed/pasted text — the classic translator workflow).
# Stateless request/response: unlike voice sessions there is no event stream, the
# client re-sends the full current text and guards result freshness itself.
# Sync def for the same threadpool reason as the image routes: an LLM call takes
# seconds and must not hold the event loop.
@api_router.post("/text-translation")
def post_text_translation(request: Request, payload: TextTranslationRequest) -> dict[str, Any]:
    text = str(payload.text or "")
    if not text.strip():
        raise HTTPException(status_code=400, detail="empty text")
    try:
        translation_language_code(payload.source_language)
        translation_language_code(payload.target_language)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    principal, entitlements, _ = resolve_request_context(request)
    entitlements.require_enabled("text_translation.enabled")
    max_chars = entitlements.get_int("text_translation.max_characters_per_job")
    if len(text) > max_chars:
        raise HTTPException(status_code=400, detail=f"text too long (max {max_chars} characters)")
    payload_hash = text_translation_payload_hash(
        source_language=payload.source_language,
        target_language=payload.target_language,
        text=text,
    )
    cached = text_translation_success_cache.get(principal, payload_hash)
    if cached is not None:
        return cached

    with admit_text_translation(principal, entitlements):
        bridge = TranslationBridge(
            source_language=payload.source_language,
            target_language=payload.target_language,
            quality=get_str("text_translation.quality", "fast"),
        )
        try:
            result = bridge.translate(text)
        except TranslationServicesError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc))
        response = {
            "translated_text": result.text,
            "profile": result.profile,
            "quality": result.quality,
        }
        text_translation_success_cache.put(
            principal,
            payload_hash,
            response,
            ttl_s=get_int("text_translation.success_cache_ttl_s"),
            max_entries=get_int("text_translation.success_cache_max_entries"),
        )
    return response


@api_router.post("/voice-library/stable")
def post_stable_voice_sample(request: Request, payload: GenerateStableVoiceSampleRequest) -> dict[str, Any]:
    tag = (payload.language or "").strip().lower()
    gender = (payload.gender or "").strip().lower()
    engine = (payload.engine or "").strip().lower()
    if not tag:
        raise HTTPException(status_code=400, detail="language_required")
    if not gender:
        raise HTTPException(status_code=400, detail="gender_required")
    if not engine:
        raise HTTPException(status_code=400, detail="engine_required")
    principal, _, _ = resolve_request_context(request)
    try:
        info = generate_stable_sample(
            tag,
            gender,
            engine,
            fairness_key=tts_fairness_key_for_principal(principal),
        )
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
    voice_cloning, cloning_errors = normalize_voice_cloning_settings(
        payload.voice_cloning,
        supported=tts_supports_voice_cloning(tts_settings),
    )
    if cloning_errors:
        raise HTTPException(status_code=422, detail={"voice_cloning": cloning_errors})
    principal, _, _ = resolve_request_context(request)
    session = SESSIONS.create_session(
        side_a_language=side_a_language,
        side_b_language=side_b_language,
        live_settings=live_settings,
        tts_settings=tts_settings,
        voice_cloning=voice_cloning,
        tts_fairness_key=tts_fairness_key_for_principal(principal),
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
