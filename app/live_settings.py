from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from app.config import get_bool, get_float, get_int, get_setting, optional_str


VALID_ASR_BACKENDS = {"whisperx", "faster_whisper_direct"}


@dataclass(frozen=True)
class SettingSpec:
    value_type: str
    nullable: bool = False
    min_value: float | None = None
    max_value: float | None = None
    enum: frozenset[str] | None = None
    live_update: bool = True


SETTING_SPECS: dict[str, SettingSpec] = {
    "timing.emit_min_ms": SettingSpec("int", min_value=0),
    "asr.backend": SettingSpec("str", enum=frozenset(VALID_ASR_BACKENDS)),
    "asr.beam_size": SettingSpec("int", nullable=True, min_value=1, max_value=16),
    "asr.chunk_size": SettingSpec("int", nullable=True, min_value=1, max_value=60),
    "asr.chunk_length": SettingSpec("int", nullable=True, min_value=1, max_value=60),
    "asr.vad_filter": SettingSpec("bool", nullable=True),
    "asr.align_enabled": SettingSpec("bool", live_update=False),
    "asr.diarize_enabled": SettingSpec("bool", live_update=False),
    "asr.diarize_speaker_mode": SettingSpec("str", enum=frozenset({"none", "auto", "fixed"}), live_update=False),
    "asr.diarize_min_speakers": SettingSpec("int", min_value=1, max_value=16, live_update=False),
    "asr.diarize_max_speakers": SettingSpec("int", min_value=1, max_value=16, live_update=False),
    "asr.word_timestamps": SettingSpec("bool", nullable=True, live_update=False),
    "asr.max_new_tokens": SettingSpec("int", nullable=True, min_value=1, max_value=512, live_update=False),
    "asr.hotwords": SettingSpec("str", nullable=True, live_update=False),
    "asr.compression_ratio_threshold": SettingSpec("float", nullable=True, min_value=0.1, max_value=10.0, live_update=False),
    "asr.log_prob_threshold": SettingSpec("float", nullable=True, min_value=-10.0, max_value=0.0, live_update=False),
    "asr.no_speech_threshold": SettingSpec("float", nullable=True, min_value=0.0, max_value=1.0, live_update=False),
    "asr.language_detection_threshold": SettingSpec("float", nullable=True, min_value=0.0, max_value=1.0, live_update=False),
    "asr.language_detection_segments": SettingSpec("int", nullable=True, min_value=1, max_value=10, live_update=False),
    "rolling.min_infer_audio_ms": SettingSpec("int", min_value=1, max_value=60000),
    "rolling.single_segment_commit_min_ms": SettingSpec("int", min_value=1, max_value=120000),
    "rolling.force_commit_repeats": SettingSpec("int", min_value=1, max_value=32),
    "rolling.max_uncommitted_ms": SettingSpec("int", min_value=1, max_value=180000),
    "rolling.hard_clip_keep_tail_ms": SettingSpec("int", min_value=1, max_value=120000),
    "rolling.max_decode_window_ms": SettingSpec("int", min_value=1, max_value=120000),
    "rolling.buffer_trim_threshold_ms": SettingSpec("int", min_value=1, max_value=300000),
    "rolling.buffer_trim_drop_ms": SettingSpec("int", min_value=1, max_value=300000),
    "rolling.min_new_audio_ms": SettingSpec("int", min_value=0, max_value=60000),
    "rolling.pacing.base_emit_ms": SettingSpec("int", min_value=1, max_value=60000),
    "rolling.pacing.startup.duration_ms": SettingSpec("int", min_value=0, max_value=60000),
    "rolling.pacing.startup.emit_ms": SettingSpec("int", min_value=1, max_value=60000),
    "rolling.pacing.startup.min_infer_audio_ms": SettingSpec("int", min_value=0, max_value=60000),
    "rolling.pacing.startup.min_new_audio_ms": SettingSpec("int", min_value=0, max_value=60000),
    "rolling.vad.enabled": SettingSpec("bool", live_update=False),
    "rolling.vad.threshold": SettingSpec("float", min_value=0.0, max_value=1.0, live_update=False),
    "rolling.vad.max_speech_duration_s": SettingSpec("float", min_value=0.1, max_value=120.0, live_update=False),
    "rolling.vad.min_speech_ms": SettingSpec("int", min_value=0, max_value=10000, live_update=False),
    "rolling.vad.hangover_ms": SettingSpec("int", min_value=0, max_value=10000, live_update=False),
    "rolling.speech_gate.silence_enter_ms": SettingSpec("int", min_value=100, max_value=60000),
    "rolling.speech_gate.rearm_hits": SettingSpec("int", min_value=1, max_value=16),
    "rolling.speech_gate.rearm_window_ms": SettingSpec("int", min_value=100, max_value=60000),
    "rolling.speech_gate.force_commit_silence_ms": SettingSpec("int", min_value=100, max_value=60000),
}


def default_live_settings() -> dict[str, Any]:
    return {
        "timing": {
            "emit_min_ms": get_int("live.timing.emit_min_ms", 120, min_value=0),
        },
        "asr": {
            "backend": _valid_backend(optional_str("live.asr.backend") or "whisperx"),
            "beam_size": _optional_int_config("live.asr.beam_size"),
            "chunk_size": _optional_int_config("live.asr.chunk_size"),
            "chunk_length": _optional_int_config("live.asr.chunk_length"),
            "vad_filter": _optional_bool_config("live.asr.vad_filter"),
            "align_enabled": get_bool("live.asr.align_enabled", False),
            "diarize_enabled": get_bool("live.asr.diarize_enabled", False),
            "diarize_speaker_mode": optional_str("live.asr.diarize_speaker_mode") or "fixed",
            "diarize_min_speakers": get_int("live.asr.diarize_min_speakers", 1, min_value=1),
            "diarize_max_speakers": get_int("live.asr.diarize_max_speakers", 4, min_value=1),
            "word_timestamps": _optional_bool_config("live.asr.word_timestamps"),
            "max_new_tokens": _optional_int_config("live.asr.max_new_tokens"),
            "hotwords": optional_str("live.asr.hotwords"),
            "compression_ratio_threshold": _optional_float_config("live.asr.compression_ratio_threshold"),
            "log_prob_threshold": _optional_float_config("live.asr.log_prob_threshold"),
            "no_speech_threshold": _optional_float_config("live.asr.no_speech_threshold"),
            "language_detection_threshold": _optional_float_config("live.asr.language_detection_threshold"),
            "language_detection_segments": _optional_int_config("live.asr.language_detection_segments"),
        },
        "rolling": {
            "min_infer_audio_ms": get_int("live.rolling.min_infer_audio_ms", 500, min_value=1),
            "single_segment_commit_min_ms": get_int("live.rolling.single_segment_commit_min_ms", 12000, min_value=1),
            "force_commit_repeats": get_int("live.rolling.force_commit_repeats", 3, min_value=1),
            "max_uncommitted_ms": get_int("live.rolling.max_uncommitted_ms", 30000, min_value=1),
            "hard_clip_keep_tail_ms": get_int("live.rolling.hard_clip_keep_tail_ms", 5000, min_value=1),
            "max_decode_window_ms": get_int("live.rolling.max_decode_window_ms", 12000, min_value=1),
            "buffer_trim_threshold_ms": get_int("live.rolling.buffer_trim_threshold_ms", 30000, min_value=1),
            "buffer_trim_drop_ms": get_int("live.rolling.buffer_trim_drop_ms", 20000, min_value=1),
            "min_new_audio_ms": get_int("live.rolling.min_new_audio_ms", 500, min_value=0),
            "pacing": {
                "base_emit_ms": get_int("live.rolling.pacing.base_emit_ms", 250, min_value=1),
                "startup": {
                    "duration_ms": get_int("live.rolling.pacing.startup.duration_ms", 1200, min_value=0),
                    "emit_ms": get_int("live.rolling.pacing.startup.emit_ms", 100, min_value=1),
                    "min_infer_audio_ms": get_int("live.rolling.pacing.startup.min_infer_audio_ms", 250, min_value=0),
                    "min_new_audio_ms": get_int("live.rolling.pacing.startup.min_new_audio_ms", 200, min_value=0),
                },
            },
            "vad": {
                "enabled": get_bool("live.rolling.vad.enabled", False),
                "threshold": get_float("live.rolling.vad.threshold", 0.35, min_value=0.0),
                "max_speech_duration_s": get_float("live.rolling.vad.max_speech_duration_s", 12.0, min_value=0.1),
                "min_speech_ms": get_int("live.rolling.vad.min_speech_ms", 120, min_value=0),
                "hangover_ms": get_int("live.rolling.vad.hangover_ms", 600, min_value=0),
            },
            "speech_gate": {
                "silence_enter_ms": get_int("live.rolling.speech_gate.silence_enter_ms", 900, min_value=100),
                "rearm_hits": get_int("live.rolling.speech_gate.rearm_hits", 2, min_value=1),
                "rearm_window_ms": get_int("live.rolling.speech_gate.rearm_window_ms", 500, min_value=100),
                "force_commit_silence_ms": get_int("live.rolling.speech_gate.force_commit_silence_ms", 2500, min_value=100),
            },
        },
    }


def merge_live_settings(base: Mapping[str, Any], delta: Mapping[str, Any]) -> dict[str, Any]:
    merged = deepcopy(dict(base))
    _merge_nested(merged, delta)
    return merged


def normalize_live_settings_delta(
    payload: Any,
    *,
    live_update: bool,
) -> tuple[dict[str, Any], list[str]]:
    if not isinstance(payload, Mapping):
        return {}, ["settings must be an object"]
    out: dict[str, Any] = {}
    errors: list[str] = []
    for path, value in _flatten(payload).items():
        spec = SETTING_SPECS.get(path)
        if spec is None:
            errors.append(f"{path}: unsupported setting")
            continue
        if live_update and not spec.live_update:
            errors.append(f"{path}: not live-updatable")
            continue
        try:
            normalized = _normalize_value(value, spec)
        except ValueError as exc:
            errors.append(f"{path}: {exc}")
            continue
        _set_path(out, path, normalized)
    return out, errors


def get_live_setting(settings: Mapping[str, Any] | None, path: str, default: Any = None) -> Any:
    cur: Any = settings if isinstance(settings, Mapping) else {}
    for part in str(path).split("."):
        if not isinstance(cur, Mapping) or part not in cur:
            return default
        cur = cur[part]
    return cur


def live_runner_config(settings: Mapping[str, Any]) -> dict[str, Any]:
    rolling = dict(get_live_setting(settings, "rolling", {}) or {})
    vad = dict(get_live_setting(settings, "rolling.vad", {}) or {})
    if "venv" not in vad:
        vad["venv"] = optional_str("live.rolling.vad.venv")
    rolling["vad"] = vad
    return {
        "timing": dict(get_live_setting(settings, "timing", {}) or {}),
        "rolling": rolling,
    }


def _flatten(payload: Mapping[str, Any], prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in payload.items():
        key_text = str(key or "").strip()
        if not key_text:
            continue
        path = f"{prefix}.{key_text}" if prefix else key_text
        if isinstance(value, Mapping):
            out.update(_flatten(value, path))
        else:
            out[path] = value
    return out


def _set_path(payload: dict[str, Any], path: str, value: Any) -> None:
    cur = payload
    parts = str(path).split(".")
    for part in parts[:-1]:
        existing = cur.get(part)
        if not isinstance(existing, dict):
            existing = {}
            cur[part] = existing
        cur = existing
    cur[parts[-1]] = value


def _merge_nested(target: dict[str, Any], delta: Mapping[str, Any]) -> None:
    for key, value in delta.items():
        if isinstance(value, Mapping) and isinstance(target.get(key), dict):
            _merge_nested(target[key], value)
        else:
            target[key] = deepcopy(value)


def _normalize_value(value: Any, spec: SettingSpec) -> Any:
    if value is None or value == "":
        if spec.nullable:
            return None
        raise ValueError("value is required")
    if spec.value_type == "bool":
        normalized = _to_bool(value)
    elif spec.value_type == "int":
        normalized = int(value)
    elif spec.value_type == "float":
        normalized = float(value)
    elif spec.value_type == "str":
        normalized = str(value).strip()
        if not normalized and spec.nullable:
            return None
        if not normalized:
            raise ValueError("value is required")
    else:
        raise ValueError("unsupported type")
    if spec.min_value is not None and isinstance(normalized, int | float):
        normalized = max(type(normalized)(spec.min_value), normalized)
    if spec.max_value is not None and isinstance(normalized, int | float):
        normalized = min(type(normalized)(spec.max_value), normalized)
    if spec.enum is not None and str(normalized) not in spec.enum:
        raise ValueError("unsupported value")
    return normalized


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    raise ValueError("expected boolean")


def _valid_backend(value: str) -> str:
    text = str(value or "").strip()
    return text if text in VALID_ASR_BACKENDS else "whisperx"


def _optional_int_config(path: str) -> int | None:
    raw = get_setting(path, None)
    if raw is None:
        return None
    return int(max(1, int(raw)))


def _optional_float_config(path: str) -> float | None:
    raw = get_setting(path, None)
    if raw is None:
        return None
    return float(raw)


def _optional_bool_config(path: str) -> bool | None:
    raw = get_setting(path, None)
    if raw is None:
        return None
    return bool(raw)
