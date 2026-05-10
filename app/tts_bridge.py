from __future__ import annotations

import base64
import copy
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
from urllib.error import HTTPError
from urllib.error import URLError
from urllib.request import Request
from urllib.request import urlopen

from app.config import REPO_ROOT
from app.config import get_bool
from app.config import get_float
from app.config import get_setting
from app.config import get_str
from app.config import rooted_path


TTS_ROOT = (REPO_ROOT / "data" / "tts").resolve()
LOGGER = logging.getLogger("asr_translate_tts.tts_metrics")
_TTS_BRIDGE: TTSBridge | None = None
_TTS_BRIDGE_LOCK = threading.Lock()
_TTS_SETTINGS_LOCK = threading.Lock()
_TTS_RUNTIME_OVERRIDES: dict[str, Any] = {}
TTS_BACKEND_OPTIONS = (
    ("kokoro", "Kokoro"),
    ("voxcpm2", "VoxCPM2"),
)
KOKORO_VOICE_OPTIONS = {
    "English": (
        ("af_heart", "Heart"),
        ("af_sarah", "Sarah"),
        ("af_nicole", "Nicole"),
        ("af_nova", "Nova"),
        ("am_adam", "Adam"),
        ("am_michael", "Michael"),
        ("am_puck", "Puck"),
    ),
    "British English": (
        ("bf_emma", "Emma"),
        ("bf_alice", "Alice"),
        ("bf_isabella", "Isabella"),
        ("bm_daniel", "Daniel"),
        ("bm_fable", "Fable"),
        ("bm_george", "George"),
        ("bm_lewis", "Lewis"),
    ),
    "Spanish": (
        ("ef_dora", "Dora"),
        ("em_alex", "Alex"),
        ("em_santa", "Santa"),
    ),
    "French": (
        ("ff_siwis", "Siwis"),
    ),
    "Hindi": (
        ("hf_alpha", "Alpha"),
        ("hf_beta", "Beta"),
        ("hm_omega", "Omega"),
        ("hm_psi", "Psi"),
    ),
    "Italian": (
        ("if_sara", "Sara"),
        ("im_nicola", "Nicola"),
    ),
    "Portuguese": (
        ("pf_dora", "Dora"),
        ("pm_alex", "Alex"),
        ("pm_santa", "Santa"),
    ),
    "Brazilian Portuguese": (
        ("pf_dora", "Dora"),
        ("pm_alex", "Alex"),
        ("pm_santa", "Santa"),
    ),
    "Chinese": (
        ("zf_xiaobei", "Xiaobei"),
        ("zf_xiaoxiao", "Xiaoxiao"),
        ("zf_xiaoyi", "Xiaoyi"),
        ("zf_xiaoni", "Xiaoni"),
        ("zm_yunjian", "Yunjian"),
        ("zm_yunxi", "Yunxi"),
        ("zm_yunxia", "Yunxia"),
        ("zm_yunyang", "Yunyang"),
    ),
    "Japanese": (
        ("jf_alpha", "Alpha"),
        ("jf_gongitsune", "Gongitsune"),
        ("jf_nezumi", "Nezumi"),
        ("jf_tebukuro", "Tebukuro"),
        ("jm_kumo", "Kumo"),
    ),
}
VOXCPM2_VOICE_PRESETS = {
    "configured": {
        "label": "Default",
        "prompt": "",
    },
    "neutral_clear": {
        "label": "Neutral clear",
        "prompt": "Use a clear, neutral adult voice with steady articulation.",
    },
    "warm_female": {
        "label": "Warm female",
        "prompt": "Use a warm adult female voice with natural intonation.",
    },
    "calm_male": {
        "label": "Calm male",
        "prompt": "Use a calm adult male voice with measured delivery.",
    },
    "focused_narrator": {
        "label": "Focused narrator",
        "prompt": "Use a focused narrator voice with crisp diction.",
    },
}
VOXCPM2_REFERENCE_PROMPT = "Match the speaking pace, rhythm, and articulation of the reference audio."
VOXCPM2_REFERENCE_MATCH_OPTIONS = (
    ("voice", "Voice only"),
    ("voice_and_pace", "Voice + pace"),
)


class TTSBridge:
    @property
    def enabled(self) -> bool:
        return _tts_enabled()

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

        request_payload, request_metrics, request_metadata = _tts_pool_request_payload(
            text=safe_text,
            language=language,
            reference_wav_path=reference_wav_path,
        )
        request_started = time.perf_counter()
        response = _post_json(
            f"{_tts_pool_base_url()}/v1/responses",
            request_payload,
            timeout_s=_tts_pool_timeout_s(),
        )
        request_wall_ms = (time.perf_counter() - request_started) * 1000.0
        audio_payload = response.get("audio")
        if not isinstance(audio_payload, dict):
            raise ValueError("tts_pool_response_missing_audio")
        audio_bytes = _decode_audio_payload(audio_payload)

        write_started = time.perf_counter()
        path.write_bytes(audio_bytes)
        artifact_write_ms = (time.perf_counter() - write_started) * 1000.0
        total_wall_ms = (time.perf_counter() - call_started) * 1000.0

        metrics = _numeric_dict(response.get("metrics"))
        metrics.update(request_metrics)
        metrics.update(
            {
                "tts_pool_request_wall_ms": request_wall_ms,
                "tts_artifact_write_ms": artifact_write_ms,
                "tts_total_wall_ms": total_wall_ms,
                "input_chars": float(len(safe_text)),
                "output_audio_seconds": float(audio_payload.get("duration_ms") or 0) / 1000.0,
            }
        )
        metadata = dict(response.get("metadata") or {})
        metadata.update(request_metadata)
        metadata.update(
            {
                "tts_pool_response_id": str(response.get("id") or ""),
                "tts_pool_model": str(response.get("model") or request_payload["model"]),
            }
        )
        payload = {
            "artifact_id": artifact_id,
            "url": rooted_path(f"/api/sessions/{_safe_token(session_id)}/tts/{artifact_id}"),
            "mime_type": str(audio_payload.get("mime_type") or "audio/wav"),
            "sample_rate_hz": audio_payload.get("sample_rate_hz"),
            "duration_ms": audio_payload.get("duration_ms"),
            "metrics": metrics,
            "metadata": metadata,
            "chars": len(safe_text),
            "language": str(language or ""),
        }
        _log_tts_metrics(session_id=session_id, artifact_id=artifact_id, payload=payload)
        return payload


def get_tts_bridge() -> TTSBridge:
    global _TTS_BRIDGE
    with _TTS_BRIDGE_LOCK:
        if _TTS_BRIDGE is None:
            _TTS_BRIDGE = TTSBridge()
        return _TTS_BRIDGE


def tts_settings_payload() -> dict[str, Any]:
    payload = _current_tts_settings()
    payload["options"] = {
        "backends": _options_payload(TTS_BACKEND_OPTIONS),
        "kokoro_voices": {
            language: _options_payload(options)
            for language, options in KOKORO_VOICE_OPTIONS.items()
        },
        "voxcpm2_voice_presets": _options_payload(
            (key, str(value["label"]), str(value["prompt"] or ""))
            for key, value in VOXCPM2_VOICE_PRESETS.items()
        ),
        "voxcpm2_reference_prompt": VOXCPM2_REFERENCE_PROMPT,
        "voxcpm2_reference_match_options": _options_payload(VOXCPM2_REFERENCE_MATCH_OPTIONS),
    }
    return payload


def update_tts_settings(delta: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    normalized, errors = _normalize_tts_settings_delta(delta)
    if errors:
        return tts_settings_payload(), errors
    with _TTS_SETTINGS_LOCK:
        _merge_settings_into(_TTS_RUNTIME_OVERRIDES, normalized)
    return tts_settings_payload(), {}


def clear_tts_runtime_overrides() -> None:
    with _TTS_SETTINGS_LOCK:
        _TTS_RUNTIME_OVERRIDES.clear()


def tts_uses_asr_reference_wav() -> bool:
    return bool(_current_tts_settings()["voxcpm2"]["use_input_audio_reference"])


def artifact_path(session_id: str, artifact_id: str) -> Path:
    return (TTS_ROOT / _safe_token(session_id) / f"{_safe_token(artifact_id)}.wav").resolve()


def _tts_pool_request_payload(
    *,
    text: str,
    language: str,
    reference_wav_path: str | None,
) -> tuple[dict[str, Any], dict[str, float], dict[str, Any]]:
    settings = _current_tts_settings()
    backend = settings["backend"]
    voice: dict[str, Any] = {}
    request_metrics: dict[str, float] = {}
    request_metadata: dict[str, Any] = {}
    if backend == "kokoro":
        preset = _kokoro_voice_for_language(language)
        if preset:
            voice["preset"] = preset
    elif backend == "voxcpm2":
        preset = str(_lookup_language_value(settings["voxcpm2"]["voice_presets"], language) or "configured")
        voice["preset"] = preset
        if settings["voxcpm2"]["use_input_audio_reference"] and reference_wav_path:
            reference_audio, reference_metrics, reference_metadata = _reference_audio_payload(
                reference_wav_path,
                max_duration_s=settings["voxcpm2"]["reference_max_duration_s"],
            )
            voice["reference_audio"] = reference_audio
            voice["reference_audio_match"] = settings["voxcpm2"]["reference_match"]
            request_metrics.update(reference_metrics)
            request_metadata.update(reference_metadata)
    else:
        raise ValueError(f"unsupported tts.backend: {backend!r}")
    return {
        "model": backend,
        "input": text,
        "language": str(language or ""),
        "voice": voice,
        "format": {"type": "wav"},
        "stream": False,
    }, request_metrics, request_metadata


def _reference_audio_payload(reference_wav_path: str, *, max_duration_s: float) -> tuple[dict[str, Any], dict[str, float], dict[str, Any]]:
    started = time.perf_counter()
    path = Path(reference_wav_path).expanduser().resolve()
    source_duration_ms = _wav_duration_ms(path)
    max_duration_ms = int(max_duration_s * 1000)
    if source_duration_ms > max_duration_ms:
        audio_bytes, duration_ms = _copy_wav_tail_to_bytes(path, max_duration_s=max_duration_s)
        clipped = True
    else:
        audio_bytes = path.read_bytes()
        duration_ms = source_duration_ms
        clipped = False
    prepare_wall_ms = (time.perf_counter() - started) * 1000.0
    return {
        "mime_type": "audio/wav",
        "data_base64": base64.b64encode(audio_bytes).decode("ascii"),
        "max_duration_s": float(max_duration_s),
    }, {
        "tts_reference_prepare_wall_ms": prepare_wall_ms,
        "tts_reference_payload_bytes": float(len(audio_bytes)),
    }, {
        "reference_client_source_duration_ms": source_duration_ms,
        "reference_client_duration_ms": duration_ms,
        "reference_client_clipped": clipped,
    }


def _wav_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as reader:
        framerate = reader.getframerate()
        frames = reader.getnframes()
        if framerate <= 0:
            raise ValueError("reference wav has invalid framerate")
        return int((frames / framerate) * 1000)


def _copy_wav_tail_to_bytes(source_path: Path, *, max_duration_s: float) -> tuple[bytes, int]:
    with wave.open(str(source_path), "rb") as reader:
        framerate = reader.getframerate()
        if framerate <= 0:
            raise ValueError("reference wav has invalid framerate")
        total_frames = reader.getnframes()
        keep_frames = min(total_frames, max(1, int(max_duration_s * framerate)))
        start_frame = max(0, total_frames - keep_frames)
        reader.setpos(start_frame)
        frames = reader.readframes(keep_frames)
        params = reader.getparams()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setparams(params)
        writer.writeframes(frames)
    return buffer.getvalue(), int((keep_frames / framerate) * 1000)


def _post_json(url: str, payload: dict[str, Any], *, timeout_s: float) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    request = Request(
        url,
        data=data,
        headers={
            "accept": "application/json",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout_s) as response:
            response_bytes = response.read()
    except HTTPError as exc:
        detail = _http_error_detail(exc)
        raise RuntimeError(f"tts_pool_http_{exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"tts_pool_unreachable: {exc.reason}") from exc
    payload = json.loads(response_bytes.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("tts_pool_response_must_be_object")
    return payload


def _http_error_detail(exc: HTTPError) -> str:
    try:
        body = exc.read().decode("utf-8", errors="replace")
    except Exception:
        return str(exc)
    try:
        payload = json.loads(body)
    except Exception:
        return body.strip() or str(exc)
    detail = payload.get("detail") if isinstance(payload, dict) else None
    if isinstance(detail, dict):
        return json.dumps(detail, ensure_ascii=True, sort_keys=True)
    if detail is not None:
        return str(detail)
    return body.strip() or str(exc)


def _decode_audio_payload(audio_payload: dict[str, Any]) -> bytes:
    data = str(audio_payload.get("data_base64") or "")
    if not data:
        raise ValueError("tts_pool_response_missing_audio_data")
    return base64.b64decode(data, validate=True)


def _numeric_dict(value: Any) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    metrics: dict[str, float] = {}
    for key, item in value.items():
        if item is None:
            continue
        try:
            metrics[str(key)] = float(item)
        except (TypeError, ValueError):
            continue
    return metrics


def _tts_pool_base_url() -> str:
    return (get_str("tts_pool.base_url", "http://127.0.0.1:8020").strip() or "http://127.0.0.1:8020").rstrip("/")


def _tts_pool_timeout_s() -> float:
    return get_float("tts_pool.timeout_s", 300.0, min_value=1.0)


def _tts_enabled() -> bool:
    return bool(_current_tts_settings()["enabled"])


def _current_tts_settings() -> dict[str, Any]:
    settings = {
        "enabled": get_bool("tts.enabled", True),
        "backend": _validated_backend(get_str("tts.backend", "kokoro")),
        "kokoro": {
            "voices": _configured_kokoro_voices(),
        },
        "voxcpm2": {
            "voice_presets": _configured_voxcpm2_voice_presets(),
            "use_input_audio_reference": get_bool("tts.voxcpm2_use_asr_reference_wav", False),
            "reference_max_duration_s": _configured_voxcpm2_reference_max_duration_s(),
            "reference_match": _configured_voxcpm2_reference_match(),
        },
    }
    with _TTS_SETTINGS_LOCK:
        overrides = copy.deepcopy(_TTS_RUNTIME_OVERRIDES)
    _merge_settings_into(settings, overrides)
    settings["backend"] = _validated_backend(settings["backend"])
    return settings


def _configured_kokoro_voices() -> dict[str, str]:
    configured = get_setting("tts.kokoro_voices", {})
    if not isinstance(configured, dict):
        configured = {}
    voices: dict[str, str] = {}
    for language, options in KOKORO_VOICE_OPTIONS.items():
        configured_voice = _lookup_language_value(configured, language)
        values = {value for value, _ in options}
        voices[language] = str(configured_voice or options[0][0]).strip()
        if voices[language] not in values:
            voices[language] = options[0][0]
    return voices


def _configured_voxcpm2_voice_presets() -> dict[str, str]:
    configured = get_setting("tts.voxcpm2_voice_presets", {})
    if not isinstance(configured, dict):
        return {}
    presets: dict[str, str] = {}
    for language, value in configured.items():
        language_key = str(language or "").strip()
        preset = str(value or "").strip()
        if language_key and preset in VOXCPM2_VOICE_PRESETS:
            presets[language_key] = preset
    return presets


def _configured_voxcpm2_reference_max_duration_s() -> float:
    return _clamped_float(get_setting("tts.voxcpm2_reference_max_duration_s", 8.0), default=8.0, min_value=1.0, max_value=60.0)


def _configured_voxcpm2_reference_match() -> str:
    return _normalized_reference_match(get_setting("tts.voxcpm2_reference_match", "voice"))


def _normalize_tts_settings_delta(delta: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    if not isinstance(delta, dict):
        return {}, {"settings": "must be an object"}
    normalized: dict[str, Any] = {}
    errors: dict[str, str] = {}
    if "enabled" in delta:
        normalized["enabled"] = bool(delta["enabled"])
    if "backend" in delta:
        try:
            normalized["backend"] = _validated_backend(delta["backend"])
        except ValueError as exc:
            errors["backend"] = str(exc)
    if "kokoro" in delta:
        kokoro = delta.get("kokoro")
        if not isinstance(kokoro, dict):
            errors["kokoro"] = "must be an object"
        elif "voices" in kokoro:
            voices = kokoro.get("voices")
            if not isinstance(voices, dict):
                errors["kokoro.voices"] = "must be an object"
            else:
                normalized.setdefault("kokoro", {})["voices"] = _normalize_kokoro_voices(voices, errors)
    if "voxcpm2" in delta:
        voxcpm2 = delta.get("voxcpm2")
        if not isinstance(voxcpm2, dict):
            errors["voxcpm2"] = "must be an object"
        else:
            normalized_voxcpm2 = normalized.setdefault("voxcpm2", {})
            if "use_input_audio_reference" in voxcpm2:
                normalized_voxcpm2["use_input_audio_reference"] = bool(voxcpm2["use_input_audio_reference"])
            if "reference_max_duration_s" in voxcpm2:
                normalized_voxcpm2["reference_max_duration_s"] = _normalize_reference_max_duration(
                    voxcpm2.get("reference_max_duration_s"),
                    errors,
                )
            if "reference_match" in voxcpm2:
                normalized_voxcpm2["reference_match"] = _normalize_reference_match(
                    voxcpm2.get("reference_match"),
                    errors,
                )
            if "voice_presets" in voxcpm2:
                presets = voxcpm2.get("voice_presets")
                if not isinstance(presets, dict):
                    errors["voxcpm2.voice_presets"] = "must be an object"
                else:
                    normalized_voxcpm2["voice_presets"] = _normalize_voxcpm2_presets(presets, errors)
    if errors:
        return {}, errors
    return normalized, {}


def _normalize_kokoro_voices(voices: dict[str, Any], errors: dict[str, str]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for language, value in voices.items():
        language_key = _known_language_key(KOKORO_VOICE_OPTIONS, language)
        if not language_key:
            errors[f"kokoro.voices.{language}"] = "unsupported language"
            continue
        voice = str(value or "").strip()
        allowed = {option_value for option_value, _ in KOKORO_VOICE_OPTIONS[language_key]}
        if voice not in allowed:
            errors[f"kokoro.voices.{language_key}"] = "unsupported voice"
            continue
        normalized[language_key] = voice
    return normalized


def _normalize_voxcpm2_presets(presets: dict[str, Any], errors: dict[str, str]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for language, value in presets.items():
        language_key = str(language or "").strip()
        preset = str(value or "").strip()
        if not language_key:
            errors["voxcpm2.voice_presets"] = "language is required"
            continue
        if preset not in VOXCPM2_VOICE_PRESETS:
            errors[f"voxcpm2.voice_presets.{language_key}"] = "unsupported preset"
            continue
        normalized[language_key] = preset
    return normalized


def _normalize_reference_max_duration(value: Any, errors: dict[str, str]) -> float:
    try:
        return _clamped_float(value, default=8.0, min_value=1.0, max_value=60.0)
    except (TypeError, ValueError):
        errors["voxcpm2.reference_max_duration_s"] = "must be a number"
        return 8.0


def _normalize_reference_match(value: Any, errors: dict[str, str]) -> str:
    text = str(value or "").strip()
    if text in {option[0] for option in VOXCPM2_REFERENCE_MATCH_OPTIONS}:
        return text
    errors["voxcpm2.reference_match"] = "unsupported reference match"
    return "voice"


def _normalized_reference_match(value: Any) -> str:
    text = str(value or "").strip()
    return text if text in {option[0] for option in VOXCPM2_REFERENCE_MATCH_OPTIONS} else "voice"


def _kokoro_voice_for_language(language: str) -> str | None:
    language_key = _known_language_key(KOKORO_VOICE_OPTIONS, language)
    if not language_key:
        return None
    voice = _current_tts_settings()["kokoro"]["voices"].get(language_key)
    return str(voice or "").strip() or None


def _validated_backend(value: Any) -> str:
    backend = str(value or "").strip().lower()
    if backend not in {"kokoro", "voxcpm2"}:
        raise ValueError(f"unsupported tts.backend: {backend!r}")
    return backend


def _clamped_float(value: Any, *, default: float, min_value: float, max_value: float) -> float:
    raw = float(value if value is not None else default)
    if raw < min_value:
        return float(min_value)
    if raw > max_value:
        return float(max_value)
    return raw


def _known_language_key(options_by_language: dict[str, Any], language: Any) -> str | None:
    text = str(language or "").strip()
    if text in options_by_language:
        return text
    folded = text.lower()
    for candidate in options_by_language:
        if candidate.lower() == folded:
            return candidate
    return None


def _lookup_language_value(values: dict[str, Any], language: Any) -> Any:
    text = str(language or "").strip()
    if text in values:
        return values[text]
    folded = text.lower()
    for candidate, value in values.items():
        if str(candidate).strip().lower() == folded:
            return value
    return None


def _merge_settings_into(target: dict[str, Any], override: dict[str, Any]) -> None:
    for key, value in override.items():
        existing = target.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            _merge_settings_into(existing, value)
        else:
            target[key] = copy.deepcopy(value)


def _options_payload(options: Any) -> list[dict[str, str]]:
    payload: list[dict[str, str]] = []
    for option in options:
        value, label, *extra = option
        item = {"value": str(value), "label": str(label)}
        if extra:
            item["prompt"] = str(extra[0])
        payload.append(item)
    return payload


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
        "tts_pool_model": metadata.get("tts_pool_model"),
        "metrics": payload.get("metrics") or {},
    }
    LOGGER.info("%s", json.dumps(log_payload, ensure_ascii=True, sort_keys=True))


def _safe_token(value: str) -> str:
    token = str(value or "").strip()
    if not token:
        raise ValueError("empty_path_token")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
    if any(ch not in allowed for ch in token):
        raise ValueError(f"unsafe_path_token:{token}")
    return token
