from __future__ import annotations

import asyncio
import io
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
from realtime_tts_engine import TTSResult

from app.config import REPO_ROOT, get_bool, get_float, get_int, get_str
from app.config import rooted_path


TTS_ROOT = (REPO_ROOT / "data" / "tts").resolve()
LOGGER = logging.getLogger("asr_translate_tts.tts_metrics")
_TTS_BRIDGE: TTSBridge | None = None
_TTS_BRIDGE_LOCK = threading.Lock()
VOXCPM2_DEFAULT_MODEL_ID = "openbmb/VoxCPM2"


class TTSBridge:
    def __init__(self) -> None:
        self.backend = _tts_backend()
        self.synthesizer = _build_synthesizer(self.backend)
        self.engine = TTSEngine(self.synthesizer)
        self._synthesis_lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return get_bool("tts.enabled", True)

    def clear_session(self, session_id: str) -> None:
        path = (TTS_ROOT / _safe_token(session_id)).resolve()
        if path.exists() and path.is_dir():
            shutil.rmtree(path)

    def synthesize(
        self,
        *,
        session_id: str,
        text: str,
        language: str,
        reference_wav_path: str | None = None,
    ) -> dict[str, Any]:
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
            voice = None
            if getattr(self, "backend", "kokoro") == "voxcpm2":
                voice = str(reference_wav_path or "").strip() or None
            result = self.engine.synthesize(TTSRequest(text=safe_text, language=language, voice=voice))
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
        if not _startup_warmup_enabled(getattr(self, "backend", "kokoro")):
            return
        with self._synthesis_lock:
            for language in _warmup_languages(self.synthesizer):
                self.engine.synthesize(TTSRequest(text=_warmup_text(language), language=language))


class VoxCPM2Synthesizer:
    def __init__(
        self,
        *,
        model_id: str,
        load_denoiser: bool,
        optimize: bool,
        cfg_value: float,
        inference_timesteps: int,
        normalize: bool,
        denoise: bool,
        control: str,
        reference_wav_path: str,
    ) -> None:
        if denoise and not load_denoiser:
            raise ValueError("tts.voxcpm2_denoise requires tts.voxcpm2_load_denoiser")
        self.model_id = str(model_id or VOXCPM2_DEFAULT_MODEL_ID).strip() or VOXCPM2_DEFAULT_MODEL_ID
        self.load_denoiser = bool(load_denoiser)
        self.optimize = bool(optimize)
        self.cfg_value = float(cfg_value)
        self.inference_timesteps = int(max(1, inference_timesteps))
        self.normalize = bool(normalize)
        self.denoise = bool(denoise)
        self.control = str(control or "").strip()
        self.reference_wav_path = str(reference_wav_path or "").strip()
        self._model: Any | None = None

    def synthesize(self, request: TTSRequest) -> TTSResult:
        start = time.perf_counter()
        model = self._model_instance()
        text = _voxcpm2_text(request.text, self.control)
        reference_wav_path = str(request.voice or self.reference_wav_path or "").strip()
        if not reference_wav_path:
            reference_wav_path = None
        generate_started = time.perf_counter()
        wav = model.generate(
            text=text,
            reference_wav_path=reference_wav_path,
            cfg_value=self.cfg_value,
            inference_timesteps=self.inference_timesteps,
            normalize=self.normalize,
            denoise=self.denoise,
        )
        generate_wall_ms = (time.perf_counter() - generate_started) * 1000.0

        encode_started = time.perf_counter()
        sample_rate_hz = int(getattr(model.tts_model, "sample_rate", 0) or 0)
        if sample_rate_hz <= 0:
            raise ValueError("VoxCPM2 model did not expose a valid sample rate")
        wav_bytes, duration_ms, audio_seconds = _wav_bytes(wav, sample_rate_hz=sample_rate_hz)
        wav_encode_ms = (time.perf_counter() - encode_started) * 1000.0
        total_wall_ms = (time.perf_counter() - start) * 1000.0
        return TTSResult(
            audio=wav_bytes,
            mime_type="audio/wav",
            sample_rate_hz=sample_rate_hz,
            duration_ms=duration_ms,
            timings={
                "voxcpm2_total_wall_ms": total_wall_ms,
                "voxcpm2_generate_wall_ms": generate_wall_ms,
                "voxcpm2_wav_encode_ms": wav_encode_ms,
                "input_chars": float(len(request.text)),
                "output_audio_seconds": audio_seconds,
                "realtime_factor": (total_wall_ms / 1000.0) / audio_seconds if audio_seconds > 0 else 0.0,
            },
            metadata={
                "engine": "voxcpm2",
                "model_id": self.model_id,
                "language": request.language,
                "device": _voxcpm2_device(model),
                "load_denoiser": self.load_denoiser,
                "optimize": self.optimize,
                "cfg_value": self.cfg_value,
                "inference_timesteps": self.inference_timesteps,
                "normalize": self.normalize,
                "denoise": self.denoise,
                "control": self.control,
                "reference_wav_path": reference_wav_path or "",
            },
        )

    def supports_language(self, language: str) -> bool:
        key = str(language or "").strip().lower().replace("_", "-")
        return key in {
            "ar",
            "arabic",
            "burmese",
            "chinese",
            "da",
            "danish",
            "de",
            "dutch",
            "en",
            "english",
            "fi",
            "finnish",
            "fr",
            "french",
            "german",
            "greek",
            "hebrew",
            "hi",
            "hindi",
            "id",
            "indonesian",
            "it",
            "italian",
            "ja",
            "japanese",
            "khmer",
            "ko",
            "korean",
            "lao",
            "malay",
            "nl",
            "no",
            "norwegian",
            "pl",
            "polish",
            "portuguese",
            "pt",
            "ru",
            "russian",
            "spanish",
            "swahili",
            "sv",
            "swedish",
            "tagalog",
            "thai",
            "tr",
            "turkish",
            "vi",
            "vietnamese",
            "zh",
        }

    def _model_instance(self) -> Any:
        if self._model is None:
            try:
                from voxcpm import VoxCPM
            except ImportError as exc:
                raise RuntimeError("Install voxcpm to use tts.backend=voxcpm2") from exc

            kwargs: dict[str, Any] = {
                "load_denoiser": self.load_denoiser,
                "optimize": self.optimize,
            }
            self._model = VoxCPM.from_pretrained(self.model_id, **kwargs)
        return self._model


def get_tts_bridge() -> TTSBridge:
    global _TTS_BRIDGE
    with _TTS_BRIDGE_LOCK:
        if _TTS_BRIDGE is None:
            _TTS_BRIDGE = TTSBridge()
        return _TTS_BRIDGE


async def warm_tts_bridge() -> None:
    await asyncio.to_thread(get_tts_bridge().warmup)


def _tts_backend() -> str:
    backend = get_str("tts.backend", "kokoro").strip().lower()
    if backend not in {"kokoro", "voxcpm2"}:
        raise ValueError(f"unsupported tts.backend: {backend!r}")
    return backend


def _build_synthesizer(backend: str) -> Any:
    if backend == "kokoro":
        return _build_kokoro_synthesizer()
    if backend == "voxcpm2":
        return _build_voxcpm2_synthesizer()
    raise ValueError(f"unsupported tts.backend: {backend!r}")


def _build_kokoro_synthesizer() -> Any:
    from realtime_tts_engine.kokoro import KokoroSynthesizer

    return KokoroSynthesizer(model_root=Path(get_str("tts.kokoro_model_root")))


def _build_voxcpm2_synthesizer() -> VoxCPM2Synthesizer:
    return VoxCPM2Synthesizer(
        model_id=get_str("tts.voxcpm2_model", VOXCPM2_DEFAULT_MODEL_ID),
        load_denoiser=get_bool("tts.voxcpm2_load_denoiser", False),
        optimize=get_bool("tts.voxcpm2_optimize", False),
        cfg_value=get_float("tts.voxcpm2_cfg_value", 2.0, min_value=0.1),
        inference_timesteps=get_int("tts.voxcpm2_inference_timesteps", 10, min_value=1),
        normalize=get_bool("tts.voxcpm2_normalize", False),
        denoise=get_bool("tts.voxcpm2_denoise", False),
        control=get_str("tts.voxcpm2_control", ""),
        reference_wav_path=get_str("tts.voxcpm2_reference_wav_path", ""),
    )


def _startup_warmup_enabled(backend: str) -> bool:
    if backend == "voxcpm2":
        return get_bool("tts.voxcpm2_startup_warmup", True)
    return get_bool("tts.startup_warmup", True)


def artifact_path(session_id: str, artifact_id: str) -> Path:
    return (TTS_ROOT / _safe_token(session_id) / f"{_safe_token(artifact_id)}.wav").resolve()


def wav_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as reader:
        frames = reader.getnframes()
        rate = max(1, reader.getframerate())
    return int(frames / rate * 1000)


def _wav_bytes(audio: Any, *, sample_rate_hz: int) -> tuple[bytes, int, float]:
    import numpy as np

    samples = np.asarray(audio, dtype=np.float32)
    if samples.ndim == 2:
        if 1 in samples.shape:
            samples = samples.reshape(-1)
        else:
            raise ValueError("VoxCPM2 returned multi-channel audio; expected mono")
    elif samples.ndim != 1:
        raise ValueError("VoxCPM2 returned unsupported audio shape")
    samples = np.nan_to_num(samples, nan=0.0, posinf=1.0, neginf=-1.0)
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(int(sample_rate_hz))
        writer.writeframes(pcm.tobytes())
    audio_seconds = float(len(pcm)) / float(sample_rate_hz)
    return buffer.getvalue(), int(audio_seconds * 1000), audio_seconds


def _voxcpm2_device(model: Any) -> str:
    device = getattr(getattr(model, "tts_model", None), "device", None)
    return str(device or "auto")


def _voxcpm2_text(text: str, control: str) -> str:
    safe_text = str(text or "").strip()
    safe_control = str(control or "").strip()
    if not safe_control:
        return safe_text
    return f"({safe_control}){safe_text}"


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


def _warmup_languages(synthesizer: Any) -> list[str]:
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
