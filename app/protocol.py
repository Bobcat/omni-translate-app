from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


PROTOCOL_VERSION = "asr_translate_tts_v1"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def event(event_type: str, session_id: str, **fields: Any) -> dict[str, Any]:
    payload = {
        "type": str(event_type),
        "protocol_version": PROTOCOL_VERSION,
        "session_id": str(session_id),
        "ts_utc": utc_now(),
    }
    payload.update(fields)
    return payload

