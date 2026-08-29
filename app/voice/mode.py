"""Product voice choices for translated speech."""

from __future__ import annotations

from typing import Any


VOICE_MODE_FEMALE = "female"
VOICE_MODE_MALE = "male"
VOICE_MODE_SPEAKER_CLONE = "speaker_clone"
DEFAULT_VOICE_MODE = VOICE_MODE_FEMALE
VOICE_MODES = (
    VOICE_MODE_FEMALE,
    VOICE_MODE_MALE,
    VOICE_MODE_SPEAKER_CLONE,
)


def normalize_voice_mode(
    value: Any,
    *,
    supported: bool,
) -> tuple[str, dict[str, str]]:
    if value is None:
        return DEFAULT_VOICE_MODE, {}
    mode = str(value or "").strip().lower()
    if mode not in VOICE_MODES:
        return DEFAULT_VOICE_MODE, {"voice_mode": "unsupported voice mode"}
    if not supported:
        return mode, {"voice_mode": "requires the active VoxCPM TTS backend"}
    return mode, {}
