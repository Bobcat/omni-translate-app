"""JSON-lines metric log used during concurrent-session investigation.

Off unless LIVE_METRICS=1 in the environment. When on, every `log_event`
call writes one compact line to `data/live_metrics.log`. Designed to be
safe to call from any thread or coroutine — a single lock serialises
the write so cross-session events don't interleave mid-line.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, TextIO

from app.config import REPO_ROOT


def _resolve_enabled() -> bool:
    # Default ON so a plain uvicorn restart is enough to capture data.
    # Set LIVE_METRICS=0 to silence (file is never opened).
    raw = os.environ.get("LIVE_METRICS", "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


_ENABLED: bool = _resolve_enabled()
_LOG_PATH: Path = REPO_ROOT / "data" / "live_metrics.log"
_FILE_LOCK = threading.Lock()
_FILE: TextIO | None = None


def enabled() -> bool:
    return _ENABLED


def log_path() -> Path:
    return _LOG_PATH


def log_event(ev: str, **fields: Any) -> None:
    if not _ENABLED:
        return
    payload: dict[str, Any] = {"t": round(time.monotonic(), 6), "ev": str(ev)}
    payload.update(fields)
    line = json.dumps(payload, separators=(",", ":"), default=str) + "\n"
    with _FILE_LOCK:
        try:
            global _FILE
            if _FILE is None:
                _LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
                _FILE = _LOG_PATH.open("a", buffering=1)
            _FILE.write(line)
        except OSError:
            pass
