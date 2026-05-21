from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import REPO_ROOT
from app.tts_bridge import (
    LANGUAGE_BCP47_BY_NAME,
    _bcp47_tag_for_language_name,
    _decode_audio_payload,
    _is_voxcpm_family_backend,
    _post_json,
    _tts_pool_base_url,
    _tts_pool_timeout_s,
)


STABLE_VOICE_LIBRARY_ROOT = (REPO_ROOT / "data" / "voice_library" / "stable").resolve()
REFERENCE_TEXTS_ROOT = (REPO_ROOT / "config" / "voice_reference_texts").resolve()
STABLE_VOICE_GENDERS = ("female", "male")
_KNOWN_TAGS = frozenset(LANGUAGE_BCP47_BY_NAME.values())
_KNOWN_GENDERS = frozenset(STABLE_VOICE_GENDERS)
_STABLE_LIBRARY_PROMPTS = {
    "female": "Adult female voice. Gentle and warm.",
    "male": "Adult male voice. Gentle and calm.",
}


def stable_library_prompt(gender: str) -> str:
    return _STABLE_LIBRARY_PROMPTS.get(str(gender or "").strip().lower(), "")


def stable_voice_wav_path(language: str, gender: str) -> Path | None:
    tag = _bcp47_tag_for_language_name(language)
    if not tag:
        return None
    gender_key = str(gender or "").strip().lower()
    if gender_key not in _KNOWN_GENDERS:
        return None
    path = (STABLE_VOICE_LIBRARY_ROOT / tag / gender_key / "audio.wav").resolve()
    return path if path.exists() else None


def _sample_entry(tag: str, gender: str) -> dict[str, Any]:
    wav_path = (STABLE_VOICE_LIBRARY_ROOT / tag / gender / "audio.wav").resolve()
    pending_wav_path = (STABLE_VOICE_LIBRARY_ROOT / tag / gender / "audio.pending.wav").resolve()
    return {
        "exists": wav_path.exists(),
        "generated_at": _read_meta_generated_at(tag, gender, "meta.json"),
        "has_pending": pending_wav_path.exists(),
        "pending_generated_at": _read_meta_generated_at(tag, gender, "meta.pending.json"),
    }


def _read_meta_generated_at(tag: str, gender: str, meta_filename: str) -> str | None:
    meta_path = (STABLE_VOICE_LIBRARY_ROOT / tag / gender / meta_filename).resolve()
    if not meta_path.exists():
        return None
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    value = data.get("generated_at")
    return str(value) if value else None


def stable_voice_language_status(language_tag: str) -> dict[str, Any]:
    tag = str(language_tag or "").strip().lower()
    if tag not in _KNOWN_TAGS:
        return {
            "has_reference_text": False,
            "reference_text": "",
            "samples": {gender: {"exists": False, "generated_at": None} for gender in STABLE_VOICE_GENDERS},
        }
    ref_path = (REFERENCE_TEXTS_ROOT / f"{tag}.txt").resolve()
    reference_text = ""
    if ref_path.exists():
        try:
            reference_text = ref_path.read_text(encoding="utf-8").strip()
        except OSError:
            reference_text = ""
    return {
        "has_reference_text": bool(reference_text),
        "reference_text": reference_text,
        "samples": {gender: _sample_entry(tag, gender) for gender in STABLE_VOICE_GENDERS},
    }


def stable_voice_library_status() -> dict[str, Any]:
    return {
        "prompts": dict(_STABLE_LIBRARY_PROMPTS),
        "languages": {tag: stable_voice_language_status(tag) for tag in sorted(_KNOWN_TAGS)},
    }


def _language_name_for_tag(tag: str) -> str | None:
    text = str(tag or "").strip().lower()
    for name, candidate in LANGUAGE_BCP47_BY_NAME.items():
        if candidate == text:
            return name
    return None


def _reference_text_for_tag(tag: str) -> str:
    ref_path = (REFERENCE_TEXTS_ROOT / f"{tag}.txt").resolve()
    if not ref_path.exists():
        raise FileNotFoundError("reference_text_missing")
    text = ref_path.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("reference_text_empty")
    return text


def generate_stable_sample(language_tag: str, gender: str, engine: str) -> dict[str, Any]:
    tag = str(language_tag or "").strip().lower()
    if tag not in _KNOWN_TAGS:
        raise ValueError("unsupported_language_tag")
    gender_key = str(gender or "").strip().lower()
    if gender_key not in _KNOWN_GENDERS:
        raise ValueError("unsupported_gender")
    engine_key = str(engine or "").strip().lower()
    if not _is_voxcpm_family_backend(engine_key):
        raise ValueError("unsupported_engine")
    language_name = _language_name_for_tag(tag)
    if not language_name:
        raise ValueError("unsupported_language_tag")
    text = _reference_text_for_tag(tag)
    instructions = stable_library_prompt(gender_key)
    request_payload = {
        "model": engine_key,
        "input": text,
        "language": language_name,
        "voice": {"instructions": instructions},
        "format": {"type": "wav"},
        "stream": False,
    }
    response = _post_json(
        f"{_tts_pool_base_url()}/v1/responses",
        request_payload,
        timeout_s=_tts_pool_timeout_s(),
    )
    audio_payload = response.get("audio")
    if not isinstance(audio_payload, dict):
        raise ValueError("tts_pool_response_missing_audio")
    audio_bytes = _decode_audio_payload(audio_payload)
    sample_dir = (STABLE_VOICE_LIBRARY_ROOT / tag / gender_key).resolve()
    sample_dir.mkdir(parents=True, exist_ok=True)
    # Two-slot model: the new generation goes into audio.pending.wav
    # without touching the current audio.wav. The user explicitly
    # promotes it via Keep, or discards it via Don't keep. Regenerate
    # overwrites the pending slot.
    meta = {
        "language": tag,
        "gender": gender_key,
        "reference_text": text,
        "tts_backend": engine_key,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (sample_dir / "audio.pending.wav").write_bytes(audio_bytes)
    (sample_dir / "meta.pending.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return _sample_entry(tag, gender_key)


def keep_pending_stable_sample(language_tag: str, gender: str) -> dict[str, Any]:
    sample_dir = _sample_dir_for(language_tag, gender)
    pending_wav = sample_dir / "audio.pending.wav"
    pending_meta = sample_dir / "meta.pending.json"
    if not pending_wav.exists():
        raise FileNotFoundError("no_pending_sample")
    # Promote pending → current. Whatever was at audio.wav is overwritten
    # (and lost — there is no rollback by design).
    pending_wav.replace(sample_dir / "audio.wav")
    if pending_meta.exists():
        pending_meta.replace(sample_dir / "meta.json")
    return _sample_entry(language_tag.strip().lower(), gender.strip().lower())


def discard_pending_stable_sample(language_tag: str, gender: str) -> dict[str, Any]:
    sample_dir = _sample_dir_for(language_tag, gender)
    pending_wav = sample_dir / "audio.pending.wav"
    pending_meta = sample_dir / "meta.pending.json"
    if not pending_wav.exists() and not pending_meta.exists():
        raise FileNotFoundError("no_pending_sample")
    if pending_wav.exists():
        pending_wav.unlink()
    if pending_meta.exists():
        pending_meta.unlink()
    return _sample_entry(language_tag.strip().lower(), gender.strip().lower())


def _sample_dir_for(language_tag: str, gender: str) -> Path:
    tag = str(language_tag or "").strip().lower()
    if tag not in _KNOWN_TAGS:
        raise ValueError("unsupported_language_tag")
    gender_key = str(gender or "").strip().lower()
    if gender_key not in _KNOWN_GENDERS:
        raise ValueError("unsupported_gender")
    return (STABLE_VOICE_LIBRARY_ROOT / tag / gender_key).resolve()
