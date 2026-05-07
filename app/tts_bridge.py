from __future__ import annotations

import asyncio
import json
import logging
import shutil
import threading
import time
import uuid
import wave
from pathlib import Path
from typing import Any

from realtime_tts_engine import TTSEngine
from realtime_tts_engine import TTSRequest
from realtime_tts_engine.kokoro import KokoroSynthesizer

from app.config import REPO_ROOT, get_bool, get_str
from app.config import rooted_path


TTS_ROOT = (REPO_ROOT / "data" / "tts").resolve()
LOGGER = logging.getLogger("asr_translate_tts.tts_metrics")
_TTS_BRIDGE: TTSBridge | None = None
_TTS_BRIDGE_LOCK = threading.Lock()


class TTSBridge:
    def __init__(self) -> None:
        self.synthesizer = KokoroSynthesizer(model_root=Path(get_str("tts.kokoro_model_root")))
        self.engine = TTSEngine(self.synthesizer)
        self._synthesis_lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return get_bool("tts.enabled", True)

    def clear_session(self, session_id: str) -> None:
        path = (TTS_ROOT / _safe_token(session_id)).resolve()
        if path.exists() and path.is_dir():
            shutil.rmtree(path)

    def synthesize(self, *, session_id: str, text: str, language: str) -> dict[str, Any]:
        call_started = time.perf_counter()
        safe_text = str(text or "").strip()
        if not safe_text:
            raise ValueError("tts_text_empty")
        artifact_id = f"tts_{uuid.uuid4().hex}"
        path = artifact_path(session_id, artifact_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        wait_started = time.perf_counter()
        self._synthesis_lock.acquire()
        queue_wait_ms = (time.perf_counter() - wait_started) * 1000.0
        try:
            synthesis_started = time.perf_counter()
            result = self.engine.synthesize(TTSRequest(text=safe_text, language=language))
            synthesis_wall_ms = (time.perf_counter() - synthesis_started) * 1000.0
        finally:
            self._synthesis_lock.release()
        write_started = time.perf_counter()
        path.write_bytes(result.audio)
        artifact_write_ms = (time.perf_counter() - write_started) * 1000.0
        total_wall_ms = (time.perf_counter() - call_started) * 1000.0
        metrics = dict(result.timings)
        metrics.update(
            {
                "queue_wait_ms": queue_wait_ms,
                "tts_synthesis_wall_ms": synthesis_wall_ms,
                "tts_artifact_write_ms": artifact_write_ms,
                "tts_total_wall_ms": total_wall_ms,
                "input_chars": float(len(safe_text)),
                "output_audio_seconds": (float(result.duration_ms or 0) / 1000.0),
            }
        )
        metadata = dict(result.metadata)
        payload = {
            "artifact_id": artifact_id,
            "url": rooted_path(f"/api/sessions/{_safe_token(session_id)}/tts/{artifact_id}"),
            "mime_type": result.mime_type,
            "sample_rate_hz": result.sample_rate_hz,
            "duration_ms": result.duration_ms,
            "metrics": metrics,
            "metadata": metadata,
            "chars": len(safe_text),
            "language": str(language or ""),
        }
        _log_tts_metrics(session_id=session_id, artifact_id=artifact_id, payload=payload)
        return payload

    def warmup(self) -> None:
        if not self.enabled:
            return
        with self._synthesis_lock:
            for language in _warmup_languages(self.synthesizer):
                self.engine.synthesize(TTSRequest(text=_warmup_text(language), language=language))


def get_tts_bridge() -> TTSBridge:
    global _TTS_BRIDGE
    with _TTS_BRIDGE_LOCK:
        if _TTS_BRIDGE is None:
            _TTS_BRIDGE = TTSBridge()
        return _TTS_BRIDGE


async def warm_tts_bridge() -> None:
    await asyncio.to_thread(get_tts_bridge().warmup)


def artifact_path(session_id: str, artifact_id: str) -> Path:
    return (TTS_ROOT / _safe_token(session_id) / f"{_safe_token(artifact_id)}.wav").resolve()


def wav_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as reader:
        frames = reader.getnframes()
        rate = max(1, reader.getframerate())
    return int(frames / rate * 1000)


def _log_tts_metrics(*, session_id: str, artifact_id: str, payload: dict[str, Any]) -> None:
    metadata = dict(payload.get("metadata") or {})
    log_payload = {
        "event": "asr_translate_tts.tts",
        "session_id": str(session_id or ""),
        "artifact_id": artifact_id,
        "language": payload.get("language"),
        "voice": metadata.get("voice"),
        "device": metadata.get("device"),
        "model_id": metadata.get("model_id"),
        "metrics": payload.get("metrics") or {},
    }
    LOGGER.info("%s", json.dumps(log_payload, ensure_ascii=True, sort_keys=True))


def _warmup_languages(synthesizer: KokoroSynthesizer) -> list[str]:
    candidates = [
        get_str("tts.warmup_language", "English"),
        get_str("translation.source_language", "Dutch"),
        get_str("translation.target_language", "English"),
    ]
    out: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        language = str(candidate or "").strip()
        key = language.lower()
        if not language or key in seen:
            continue
        seen.add(key)
        if synthesizer.supports_language(language):
            out.append(language)
    return out


def _warmup_text(language: str) -> str:
    key = str(language or "").strip().lower().replace("_", "-")
    return {
        "chinese": "准备好了。",
        "zh": "准备好了。",
        "zh-cn": "准备好了。",
        "japanese": "準備できました。",
        "ja": "準備できました。",
        "ja-jp": "準備できました。",
        "french": "Pret.",
        "fr": "Pret.",
        "german": "Bereit.",
        "de": "Bereit.",
        "spanish": "Listo.",
        "es": "Listo.",
        "italian": "Pronto.",
        "it": "Pronto.",
        "portuguese": "Pronto.",
        "pt": "Pronto.",
        "brazilian portuguese": "Pronto.",
        "hindi": "Taiyar hai.",
        "hi": "Taiyar hai.",
    }.get(key, get_str("tts.warmup_text", "Ready.").strip() or "Ready.")


def _safe_token(value: str) -> str:
    token = str(value or "").strip()
    if not token:
        raise ValueError("empty_path_token")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
    if any(ch not in allowed for ch in token):
        raise ValueError(f"unsafe_path_token:{token}")
    return token
