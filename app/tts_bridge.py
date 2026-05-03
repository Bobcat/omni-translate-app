from __future__ import annotations

import shutil
import uuid
import wave
from pathlib import Path
from typing import Any

from realtime_tts_engine import DevToneSynthesizer
from realtime_tts_engine import TTSEngine
from realtime_tts_engine import TTSRequest

from app.config import REPO_ROOT, get_bool, get_str
from app.config import rooted_path


TTS_ROOT = (REPO_ROOT / "data" / "tts").resolve()


class TTSBridge:
    def __init__(self) -> None:
        backend = get_str("tts.backend", "dev_tone").strip().lower()
        if backend == "kokoro":
            from realtime_tts_engine.kokoro import KokoroSynthesizer

            synthesizer = KokoroSynthesizer(model_root=Path(get_str("tts.kokoro_model_root")))
        elif backend == "dev_tone":
            synthesizer = DevToneSynthesizer()
        else:
            raise ValueError(f"unsupported_tts_backend:{backend}")
        self.engine = TTSEngine(synthesizer)

    @property
    def enabled(self) -> bool:
        return get_bool("tts.enabled", True)

    def clear_session(self, session_id: str) -> None:
        path = (TTS_ROOT / _safe_token(session_id)).resolve()
        if path.exists() and path.is_dir():
            shutil.rmtree(path)

    def synthesize(self, *, session_id: str, text: str, language: str) -> dict[str, Any]:
        safe_text = str(text or "").strip()
        if not safe_text:
            raise ValueError("tts_text_empty")
        artifact_id = f"tts_{uuid.uuid4().hex}"
        path = artifact_path(session_id, artifact_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        result = self.engine.synthesize(TTSRequest(text=safe_text, language=language))
        path.write_bytes(result.audio)
        return {
            "artifact_id": artifact_id,
            "url": rooted_path(f"/api/sessions/{_safe_token(session_id)}/tts/{artifact_id}"),
            "mime_type": result.mime_type,
            "sample_rate_hz": result.sample_rate_hz,
            "duration_ms": result.duration_ms,
            "timings": dict(result.timings),
            "chars": len(safe_text),
            "language": str(language or ""),
        }


def artifact_path(session_id: str, artifact_id: str) -> Path:
    return (TTS_ROOT / _safe_token(session_id) / f"{_safe_token(artifact_id)}.wav").resolve()


def wav_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as reader:
        frames = reader.getnframes()
        rate = max(1, reader.getframerate())
        return int(frames / rate * 1000)


def _safe_token(value: str) -> str:
    token = str(value or "").strip()
    if not token:
        raise ValueError("empty_path_token")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
    if any(ch not in allowed for ch in token):
        raise ValueError(f"unsafe_path_token:{token}")
    return token

