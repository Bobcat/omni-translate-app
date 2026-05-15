from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from app.asr_pc_export import live_pc_events_to_text
from app.asr_pc_export import pc_export_filename
from app.config import get_int, get_str, rooted_path
from app.live_settings import default_live_settings
from app.live_settings import merge_live_settings
from app.live_settings import normalize_live_settings_delta
from app.protocol import PROTOCOL_VERSION
from app.sessions import SESSIONS
from app.tts_bridge import artifact_path
from app.tts_bridge import tts_settings_payload
from app.tts_bridge import update_tts_settings
from app.voice_library import generate_stable_sample
from app.voice_library import stable_voice_library_status


api_router = APIRouter(prefix="/api")


class CreateSessionRequest(BaseModel):
    side_a_language: str | None = None
    side_b_language: str | None = None
    live_settings: dict[str, Any] | None = None


class UpdateTTSSettingsRequest(BaseModel):
    settings: dict[str, Any]


class GenerateStableVoiceSampleRequest(BaseModel):
    language: str
    gender: str
    engine: str


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
    }


@api_router.post("/tts-settings")
async def set_tts_settings(payload: UpdateTTSSettingsRequest) -> dict[str, Any]:
    settings, errors = update_tts_settings(payload.settings)
    if errors:
        raise HTTPException(status_code=422, detail={"tts": errors})
    return {"tts": settings}


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
    session = SESSIONS.create_session(
        side_a_language=side_a_language,
        side_b_language=side_b_language,
        live_settings=live_settings,
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
    from app.voice_library import STABLE_VOICE_GENDERS, STABLE_VOICE_LIBRARY_ROOT
    tag = (language or "").strip().lower()
    gender_key = (gender or "").strip().lower()
    allowed_chars = set("abcdefghijklmnopqrstuvwxyz-_")
    if not tag or any(ch not in allowed_chars for ch in tag):
        raise HTTPException(status_code=404, detail="Sample not found")
    if gender_key not in STABLE_VOICE_GENDERS:
        raise HTTPException(status_code=404, detail="Sample not found")
    path = (STABLE_VOICE_LIBRARY_ROOT / tag / gender_key / "audio.wav").resolve()
    if not str(path).startswith(str(STABLE_VOICE_LIBRARY_ROOT)) or not path.exists():
        raise HTTPException(status_code=404, detail="Sample not found")
    return FileResponse(
        path,
        media_type="audio/wav",
        filename=f"stable-{tag}-{gender_key}.wav",
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
