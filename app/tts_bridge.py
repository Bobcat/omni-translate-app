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


class TtsReferenceUnavailableError(Exception):
    """Raised when voxcpm2 reference_audio mode has no usable reference."""
_TTS_BRIDGE_LOCK = threading.Lock()
_TTS_SETTINGS_LOCK = threading.Lock()
_TTS_RUNTIME_OVERRIDES: dict[str, Any] = {}
TTS_BACKEND_OPTIONS = (
    ("kokoro", "Kokoro"),
    ("voxcpm2", "VoxCPM2"),
    ("nanovllm_voxcpm", "NanoVLLM VoxCPM"),
)
TTS_BACKEND_OPTION_BY_VALUE = {value: (value, label) for value, label in TTS_BACKEND_OPTIONS}
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
VOXCPM2_MODE_OPTIONS = (
    ("description", "From description"),
    ("reference_audio", "From reference audio"),
)
VOXCPM2_GENDER_OPTIONS = (
    ("female", "Female"),
    ("male", "Male"),
)
VOXCPM2_STYLE_OPTIONS = (
    ("neutral", "Neutral"),
    ("warm", "Warm"),
    ("calm", "Calm"),
    ("clear", "Clear"),
)
VOXCPM2_REFERENCE_SOURCE_OPTIONS = (
    ("last_speech", "Last speech fragment", False),
    ("stable_generated", "Stable generated", False),
)
VOXCPM2_DEFAULT_TRIM_SECONDS = 4.0
VOXCPM2_DEFAULT_LANGUAGE_CONFIG = {
    "mode": "reference_audio",
    "reference_source": "stable_generated",
    "stable_gender": "female",
    "trim_seconds": VOXCPM2_DEFAULT_TRIM_SECONDS,
}
VOXCPM2_GENDER_PROMPT_CLAUSES = {
    "female": "Use a natural adult female voice.",
    "male": "Use a natural adult male voice.",
}
VOXCPM2_STYLE_PROMPT_CLAUSES = {
    "neutral": "Use a neutral, natural speaking style.",
    "warm": "Use a warm, natural speaking style.",
    "calm": "Use a calm, measured speaking style.",
    "clear": "Use a clear, articulate speaking style.",
}
# Display name -> BCP-47 lowercase tag. Mirrors static/src/shared/languages.js.
LANGUAGE_BCP47_BY_NAME = {
    "English": "en",
    "British English": "en-gb",
    "Dutch": "nl",
    "German": "de",
    "French": "fr",
    "Spanish": "es",
    "Hindi": "hi",
    "Italian": "it",
    "Portuguese": "pt-pt",
    "Brazilian Portuguese": "pt-br",
    "Polish": "pl",
    "Ukrainian": "uk",
    "Turkish": "tr",
    "Arabic": "ar",
    "Chinese": "zh-cn",
    "Japanese": "ja",
    "Korean": "ko",
    "Afrikaans": "af",
    "Danish": "da",
    "Hungarian": "hu",
    "Norwegian": "nb",
    "Romanian": "ro",
    "Russian": "ru",
    "Swedish": "sv",
    "Vietnamese": "vi",
    "Indonesian": "id",
    "Bengali": "bn",
    "Urdu": "ur",
    "Persian": "fa",
    "Thai": "th",
    "Greek": "el",
    "Czech": "cs",
    "Finnish": "fi",
    "Hebrew": "he",
    "Tamil": "ta",
    "Tagalog": "tl",
    "Malay": "ms",
    "Swahili": "sw",
    "Bulgarian": "bg",
    "Croatian": "hr",
    "Slovak": "sk",
}


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
        reference_prompt_text: str | None = None,
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
            reference_prompt_text=reference_prompt_text,
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
    backend_options = _loaded_tts_backend_options()
    if backend_options and payload["backend"] not in {option[0] for option in backend_options}:
        payload["backend"] = backend_options[0][0]
    payload["options"] = {
        "backends": _options_payload(backend_options),
        "kokoro_voices": {
            language: _options_payload(options)
            for language, options in KOKORO_VOICE_OPTIONS.items()
        },
        "voxcpm2_modes": _options_payload(VOXCPM2_MODE_OPTIONS),
        "voxcpm2_genders": _options_payload(VOXCPM2_GENDER_OPTIONS),
        "voxcpm2_styles": _options_payload(VOXCPM2_STYLE_OPTIONS),
        "voxcpm2_reference_sources": [
            {"value": str(value), "label": str(label), "disabled": bool(disabled)}
            for value, label, disabled in VOXCPM2_REFERENCE_SOURCE_OPTIONS
        ],
    }
    return payload


def update_tts_settings(delta: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    normalized, errors = _normalize_tts_settings_delta(delta)
    if errors:
        return tts_settings_payload(), errors
    languages_replacement: dict[str, Any] | None = None
    if isinstance(normalized.get("voxcpm2"), dict) and "languages" in normalized["voxcpm2"]:
        languages_replacement = normalized["voxcpm2"].pop("languages")
    with _TTS_SETTINGS_LOCK:
        _merge_settings_into(_TTS_RUNTIME_OVERRIDES, normalized)
        if languages_replacement is not None:
            _TTS_RUNTIME_OVERRIDES.setdefault("voxcpm2", {})["languages"] = languages_replacement
    return tts_settings_payload(), {}


def clear_tts_runtime_overrides() -> None:
    with _TTS_SETTINGS_LOCK:
        _TTS_RUNTIME_OVERRIDES.clear()


def tts_uses_asr_reference_wav(language: str) -> bool:
    settings = _current_tts_settings()
    if not _is_voxcpm_family_backend(settings["backend"]):
        return False
    config = _voxcpm2_language_config(settings["voxcpm2"]["languages"], language)
    if config["mode"] != "reference_audio":
        return False
    return config.get("reference_source", "stable_generated") == "last_speech"


def artifact_path(session_id: str, artifact_id: str) -> Path:
    return (TTS_ROOT / _safe_token(session_id) / f"{_safe_token(artifact_id)}.wav").resolve()


def _tts_pool_request_payload(
    *,
    text: str,
    language: str,
    reference_wav_path: str | None,
    reference_prompt_text: str | None = None,
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
    elif _is_voxcpm_family_backend(backend):
        config = _voxcpm2_language_config(settings["voxcpm2"]["languages"], language)
        resolved_reference_path: str | None = None
        reference_source = config.get("reference_source", "stable_generated")
        if config["mode"] == "reference_audio":
            if reference_source == "stable_generated":
                from app.voice_library import stable_voice_wav_path
                stable_gender = str(config.get("stable_gender") or "female")
                stable_path = stable_voice_wav_path(language, stable_gender)
                if stable_path is None:
                    # Hardcoded policy: when the target language has no stable
                    # sample, fall back to English. The English sample is
                    # operator-curated and expected to always exist.
                    stable_path = stable_voice_wav_path("English", stable_gender)
                if stable_path is not None:
                    resolved_reference_path = str(stable_path)
            elif reference_source == "last_speech" and reference_wav_path:
                resolved_reference_path = reference_wav_path
        has_reference_audio = bool(resolved_reference_path)
        instructions = _voxcpm2_voice_instructions(
            language,
            config,
            has_reference_audio=has_reference_audio,
        )
        if instructions:
            voice["instructions"] = instructions
        if has_reference_audio:
            trim_s = float(config.get("trim_seconds", VOXCPM2_DEFAULT_TRIM_SECONDS))
            prompt_text, also_use_as_reference = _ultimate_cloning_choice(
                settings=settings,
                reference_source=reference_source,
                resolved_reference_path=resolved_reference_path,
                last_speech_prompt_text=reference_prompt_text,
            )
            reference_audio, reference_metrics, reference_metadata = _reference_audio_payload(
                resolved_reference_path,
                max_duration_s=trim_s,
                prompt_text=prompt_text,
                also_use_as_reference=also_use_as_reference,
            )
            voice["reference_audio"] = reference_audio
            request_metrics.update(reference_metrics)
            request_metadata.update(reference_metadata)
            request_metadata["reference_client_source"] = reference_source
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


def _voxcpm2_voice_instructions(
    language: str,
    config: dict[str, Any],
    *,
    has_reference_audio: bool,
) -> str:
    target_lang = str(language or "").strip()
    if config["mode"] == "reference_audio":
        if not has_reference_audio:
            raise TtsReferenceUnavailableError(
                f"no reference audio available for language={target_lang!r}"
            )
        return _voxcpm2_reference_instructions(target_lang)
    return _voxcpm2_description_instructions(target_lang, config)


def _voxcpm2_description_instructions(target_lang: str, config: dict[str, Any]) -> str:
    gender = str(config.get("gender") or "female")
    style = str(config.get("style") or "neutral")
    gender_clause = VOXCPM2_GENDER_PROMPT_CLAUSES.get(gender, VOXCPM2_GENDER_PROMPT_CLAUSES["female"])
    style_clause = VOXCPM2_STYLE_PROMPT_CLAUSES.get(style, VOXCPM2_STYLE_PROMPT_CLAUSES["neutral"])
    return (
        f"Speak in {target_lang}. "
        f"Pronounce numbers, abbreviations, and short fragments in {target_lang}. "
        f"{gender_clause} {style_clause} "
        "Speak clearly and generate only the requested text."
    )


def _voxcpm2_reference_instructions(target_lang: str) -> str:
    return (
        f"Speak in {target_lang}. "
        f"Pronounce numbers, abbreviations, and short fragments in {target_lang}. "
        "Use the reference audio as the voice reference. "
        f"Do not infer the output language from the reference audio; the output language is {target_lang}. "
        "Do not copy or continue the content of the reference audio. "
        "Speak clearly and generate only the requested text."
    )


def _voxcpm2_language_config(languages_map: dict[str, Any], language: str) -> dict[str, Any]:
    tag = _bcp47_tag_for_language_name(language)
    if tag and isinstance(languages_map, dict):
        entry = languages_map.get(tag)
        if isinstance(entry, dict):
            return _normalize_voxcpm2_language_entry(entry)
    return dict(VOXCPM2_DEFAULT_LANGUAGE_CONFIG)


def _bcp47_tag_for_language_name(language: Any) -> str | None:
    text = str(language or "").strip()
    if not text:
        return None
    if text in LANGUAGE_BCP47_BY_NAME:
        return LANGUAGE_BCP47_BY_NAME[text]
    folded = text.lower()
    for name, tag in LANGUAGE_BCP47_BY_NAME.items():
        if name.lower() == folded:
            return tag
    return None


def _ultimate_cloning_choice(
    *,
    settings: dict[str, Any],
    reference_source: str,
    resolved_reference_path: str,
    last_speech_prompt_text: str | None,
) -> tuple[str | None, bool]:
    """Decide whether to engage ultimate cloning for this synth call.
    Returns (prompt_text, also_use_as_reference). prompt_text=None
    means reference-only mode — the rest is irrelevant in that case.

    Toggle and UC1/UC2 selection live in
    settings["voxcpm2"]["ultimate_cloning"][<reference_source>].
    """
    cfg = (
        (settings.get("voxcpm2") or {}).get("ultimate_cloning") or {}
    ).get(reference_source) or {}
    if not bool(cfg.get("enabled")):
        return None, True
    also_use_as_reference = bool(cfg.get("also_use_as_reference", True))
    if reference_source == "stable_generated":
        # Read the canonical transcript from the meta.json that sits
        # alongside the resolved WAV. If meta is missing or empty we
        # silently fall back to reference-only — never send half-paired
        # ultimate cloning.
        prompt_text = _stable_sample_reference_text(resolved_reference_path)
        return prompt_text, also_use_as_reference
    if reference_source == "last_speech":
        text = str(last_speech_prompt_text or "").strip()
        return (text or None), also_use_as_reference
    return None, True


def _reference_audio_payload(
    reference_wav_path: str,
    *,
    max_duration_s: float,
    prompt_text: str | None = None,
    also_use_as_reference: bool = True,
) -> tuple[dict[str, Any], dict[str, float], dict[str, Any]]:
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
    reference_audio: dict[str, Any] = {
        "mime_type": "audio/wav",
        "data_base64": base64.b64encode(audio_bytes).decode("ascii"),
        "max_duration_s": float(max_duration_s),
    }
    safe_prompt_text = str(prompt_text or "").strip()
    if safe_prompt_text:
        reference_audio["prompt_text"] = safe_prompt_text
        reference_audio["also_use_as_reference"] = bool(also_use_as_reference)
    return reference_audio, {
        "tts_reference_prepare_wall_ms": prepare_wall_ms,
        "tts_reference_payload_bytes": float(len(audio_bytes)),
    }, {
        "reference_client_source_duration_ms": source_duration_ms,
        "reference_client_duration_ms": duration_ms,
        "reference_client_clipped": clipped,
        "reference_client_prompt_text": bool(safe_prompt_text),
        "reference_client_also_use_as_reference": (
            bool(also_use_as_reference) if safe_prompt_text else False
        ),
    }


def _stable_sample_reference_text(wav_path: str) -> str | None:
    """Read the reference text from the meta.json that sits next to a
    stable-library audio.wav. Returns None when the meta is missing or
    has no reference_text — caller treats that as "no transcript
    available; stay in reference-only mode".
    """
    meta_path = Path(wav_path).expanduser().resolve().parent / "meta.json"
    if not meta_path.exists():
        return None
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    text = str(data.get("reference_text") or "").strip()
    return text or None


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


def _get_json(url: str, *, timeout_s: float) -> dict[str, Any]:
    request = Request(url, headers={"accept": "application/json"}, method="GET")
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


def _tts_pool_models_timeout_s() -> float:
    return get_float("tts_pool.models_timeout_s", 2.0, min_value=0.1)


def _tts_pool_loaded_models() -> set[str]:
    try:
        payload = _get_json(
            f"{_tts_pool_base_url()}/v1/models",
            timeout_s=_tts_pool_models_timeout_s(),
        )
    except (RuntimeError, ValueError, json.JSONDecodeError) as exc:
        LOGGER.warning("TTS pool model list unavailable: %s", exc)
        return set()
    models = payload.get("models")
    if not isinstance(models, list):
        return set()
    return {str(model or "").strip() for model in models if str(model or "").strip()}


def _loaded_tts_backend_options() -> tuple[tuple[str, str], ...]:
    loaded = _tts_pool_loaded_models()
    return tuple(TTS_BACKEND_OPTION_BY_VALUE[value] for value, _ in TTS_BACKEND_OPTIONS if value in loaded)


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
            "languages": {},
            "ultimate_cloning": {
                "stable_generated": {
                    "enabled": get_bool("tts.voxcpm2.ultimate_cloning.stable_generated.enabled", True),
                    "also_use_as_reference": get_bool(
                        "tts.voxcpm2.ultimate_cloning.stable_generated.also_use_as_reference", True
                    ),
                },
                "last_speech": {
                    "enabled": get_bool("tts.voxcpm2.ultimate_cloning.last_speech.enabled", False),
                    "also_use_as_reference": get_bool(
                        "tts.voxcpm2.ultimate_cloning.last_speech.also_use_as_reference", True
                    ),
                },
            },
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
            if "languages" in voxcpm2:
                languages = voxcpm2.get("languages")
                if not isinstance(languages, dict):
                    errors["voxcpm2.languages"] = "must be an object"
                else:
                    normalized_voxcpm2["languages"] = _normalize_voxcpm2_languages(languages, errors)
            if "ultimate_cloning" in voxcpm2:
                ultimate = voxcpm2.get("ultimate_cloning")
                if not isinstance(ultimate, dict):
                    errors["voxcpm2.ultimate_cloning"] = "must be an object"
                else:
                    normalized_voxcpm2["ultimate_cloning"] = _normalize_ultimate_cloning(ultimate, errors)
    if errors:
        return {}, errors
    return normalized, {}


def _normalize_ultimate_cloning(value: dict[str, Any], errors: dict[str, str]) -> dict[str, dict[str, Any]]:
    normalized: dict[str, dict[str, Any]] = {}
    for source_key in ("stable_generated", "last_speech"):
        if source_key not in value:
            continue
        source = value.get(source_key)
        if not isinstance(source, dict):
            errors[f"voxcpm2.ultimate_cloning.{source_key}"] = "must be an object"
            continue
        entry: dict[str, Any] = {}
        if "enabled" in source:
            entry["enabled"] = bool(source.get("enabled"))
        if "also_use_as_reference" in source:
            entry["also_use_as_reference"] = bool(source.get("also_use_as_reference"))
        if entry:
            normalized[source_key] = entry
    return normalized


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


_VOXCPM2_MODE_VALUES = {value for value, _ in VOXCPM2_MODE_OPTIONS}
_VOXCPM2_GENDER_VALUES = {value for value, _ in VOXCPM2_GENDER_OPTIONS}
_VOXCPM2_STYLE_VALUES = {value for value, _ in VOXCPM2_STYLE_OPTIONS}
_VOXCPM2_REFERENCE_SOURCE_VALUES = {
    value for value, _label, disabled in VOXCPM2_REFERENCE_SOURCE_OPTIONS if not disabled
}
_VOXCPM2_KNOWN_BCP47_TAGS = set(LANGUAGE_BCP47_BY_NAME.values())


def _normalize_voxcpm2_languages(value: Any, errors: dict[str, str]) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict):
        errors["voxcpm2.languages"] = "must be an object"
        return {}
    normalized: dict[str, dict[str, Any]] = {}
    for tag, entry in value.items():
        tag_key = str(tag or "").strip().lower()
        if not tag_key:
            errors["voxcpm2.languages"] = "language tag is required"
            continue
        if tag_key not in _VOXCPM2_KNOWN_BCP47_TAGS:
            errors[f"voxcpm2.languages.{tag_key}"] = "unsupported language tag"
            continue
        if not isinstance(entry, dict):
            errors[f"voxcpm2.languages.{tag_key}"] = "must be an object"
            continue
        normalized[tag_key] = _normalize_voxcpm2_language_entry(
            entry,
            errors=errors,
            errors_prefix=f"voxcpm2.languages.{tag_key}",
        )
    return normalized


def _normalize_voxcpm2_language_entry(
    entry: dict[str, Any],
    *,
    errors: dict[str, str] | None = None,
    errors_prefix: str = "voxcpm2.languages",
) -> dict[str, Any]:
    mode = str(entry.get("mode") or "reference_audio").strip().lower()
    if mode not in _VOXCPM2_MODE_VALUES:
        if errors is not None:
            errors[f"{errors_prefix}.mode"] = "unsupported mode"
        mode = "reference_audio"
    result: dict[str, Any] = {"mode": mode}
    if mode == "description":
        gender = str(entry.get("gender") or "female").strip().lower()
        if gender not in _VOXCPM2_GENDER_VALUES:
            if errors is not None:
                errors[f"{errors_prefix}.gender"] = "unsupported gender"
            gender = "female"
        style = str(entry.get("style") or "neutral").strip().lower()
        if style not in _VOXCPM2_STYLE_VALUES:
            if errors is not None:
                errors[f"{errors_prefix}.style"] = "unsupported style"
            style = "neutral"
        result["gender"] = gender
        result["style"] = style
    else:
        reference_source = str(entry.get("reference_source") or "stable_generated").strip().lower()
        if reference_source not in _VOXCPM2_REFERENCE_SOURCE_VALUES:
            if errors is not None:
                errors[f"{errors_prefix}.reference_source"] = "unsupported reference source"
            reference_source = "stable_generated"
        trim_raw = entry.get("trim_seconds", VOXCPM2_DEFAULT_TRIM_SECONDS)
        try:
            trim = _clamped_float(
                trim_raw if trim_raw is not None else VOXCPM2_DEFAULT_TRIM_SECONDS,
                default=VOXCPM2_DEFAULT_TRIM_SECONDS,
                min_value=1.0,
                max_value=60.0,
            )
        except (TypeError, ValueError):
            if errors is not None:
                errors[f"{errors_prefix}.trim_seconds"] = "must be a number"
            trim = VOXCPM2_DEFAULT_TRIM_SECONDS
        result["reference_source"] = reference_source
        result["trim_seconds"] = trim
        if reference_source == "stable_generated":
            stable_gender = str(entry.get("stable_gender") or "female").strip().lower()
            if stable_gender not in _VOXCPM2_GENDER_VALUES:
                if errors is not None:
                    errors[f"{errors_prefix}.stable_gender"] = "unsupported gender"
                stable_gender = "female"
            result["stable_gender"] = stable_gender
    return result


def _kokoro_voice_for_language(language: str) -> str | None:
    language_key = _known_language_key(KOKORO_VOICE_OPTIONS, language)
    if not language_key:
        return None
    voice = _current_tts_settings()["kokoro"]["voices"].get(language_key)
    return str(voice or "").strip() or None


def _validated_backend(value: Any) -> str:
    backend = str(value or "").strip().lower()
    if backend not in {"kokoro", "voxcpm2", "nanovllm_voxcpm"}:
        raise ValueError(f"unsupported tts.backend: {backend!r}")
    return backend


def _is_voxcpm_family_backend(backend: Any) -> bool:
    return str(backend or "").strip().lower() in {"voxcpm2", "nanovllm_voxcpm"}


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
