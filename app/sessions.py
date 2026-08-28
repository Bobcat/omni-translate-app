from __future__ import annotations

import asyncio
import logging
import secrets
import shutil
import threading
import time
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.asr_pc_export import PC_EXPORT_ROOT
from app.asr_pc_export import live_pc_events_to_text
from app.asr_pc_export import pc_export_path
from app.asr_bridge import ASR_CHUNKS_ROOT
from app.config import get_int
from app.live_settings import default_live_settings
from app.tts_bridge import TTS_ROOT


logger = logging.getLogger(__name__)


def _utc_iso(ts: float) -> str:
    return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()


@dataclass
class ConversationSession:
    session_id: str
    created_unix: float
    expires_unix: float
    side_a_language: str
    side_b_language: str
    tts_fairness_key: str
    state: str = "created"
    ws_connected: bool = False
    closed: bool = False
    close_reason: str = ""
    live_settings: dict[str, Any] = field(default_factory=default_live_settings)
    tts_settings: dict[str, Any] = field(default_factory=dict)
    voice_cloning: dict[str, Any] = field(default_factory=lambda: {"enabled": False})
    pc_events: list[dict[str, Any]] = field(default_factory=list)
    pc_export_path: str = ""


class ConversationSessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, ConversationSession] = {}
        self._lock = threading.Lock()

    def create_session(
        self,
        *,
        side_a_language: str,
        side_b_language: str,
        tts_fairness_key: str,
        live_settings: dict[str, Any] | None = None,
        tts_settings: dict[str, Any] | None = None,
        voice_cloning: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = time.time()
        self.cleanup_expired(now=now)
        ttl_s = get_int("live.session_ttl_s", 900, min_value=60)
        session_id = f"conv_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{secrets.token_hex(4)}"
        sess = ConversationSession(
            session_id=session_id,
            created_unix=now,
            expires_unix=now + ttl_s,
            side_a_language=str(side_a_language or "Dutch"),
            side_b_language=str(side_b_language or "English"),
            tts_fairness_key=str(tts_fairness_key or ""),
            live_settings=dict(live_settings or default_live_settings()),
            tts_settings=dict(tts_settings or {}),
            voice_cloning=dict(voice_cloning or {"enabled": False}),
        )
        with self._lock:
            self._sessions[session_id] = sess
            return self._payload_locked(sess)

    def open_websocket(self, session_id: str) -> ConversationSession:
        now = time.time()
        self.cleanup_expired(now=now)
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None:
                raise KeyError("session_not_found")
            if sess.closed:
                raise RuntimeError("session_closed")
            if sess.ws_connected:
                raise RuntimeError("session_already_connected")
            sess.ws_connected = True
            sess.state = "connected"
            return sess

    def update(self, session_id: str, **fields: Any) -> dict[str, Any]:
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None:
                raise KeyError("session_not_found")
            for key, value in fields.items():
                if hasattr(sess, key):
                    setattr(sess, key, value)
            return self._payload_locked(sess)

    def close(self, session_id: str, *, reason: str) -> None:
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None:
                return
            export_ttl_s = get_int(
                "live.session_export_ttl_s",
                get_int("live.session_ttl_s", 900, min_value=60),
                min_value=60,
            )
            now = time.time()
            sess.closed = True
            sess.ws_connected = False
            sess.state = "ended"
            sess.close_reason = str(reason or "closed")
            sess.expires_unix = max(sess.expires_unix, now + export_ttl_s)
            path = pc_export_path(session_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(live_pc_events_to_text(sess.pc_events), encoding="utf-8")
            sess.pc_export_path = str(path)

    def append_pc_event(self, session_id: str, event: dict[str, Any]) -> None:
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None:
                return
            sess.pc_events.append(dict(event))

    def pc_events(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None:
                raise KeyError("session_not_found")
            return [dict(event) for event in sess.pc_events]

    def cleanup_expired(self, *, now: float | None = None, include_orphans: bool = False) -> int:
        current_time = time.time() if now is None else float(now)
        with self._lock:
            expired = [
                sess
                for sess in self._sessions.values()
                if not sess.ws_connected and current_time >= sess.expires_unix
            ]
            for sess in expired:
                self._sessions.pop(sess.session_id, None)
            active_session_ids = set(self._sessions)

        for sess in expired:
            _remove_session_artifacts(sess)
        if include_orphans:
            retention_s = get_int(
                "live.session_export_ttl_s",
                get_int("live.session_ttl_s", 900, min_value=60),
                min_value=60,
            )
            _remove_orphaned_artifacts(
                active_session_ids=active_session_ids,
                cutoff_unix=current_time - retention_s,
            )
        return len(expired)

    def _payload_locked(self, sess: ConversationSession) -> dict[str, Any]:
        return {
            "session_id": sess.session_id,
            "state": sess.state,
            "ws_connected": sess.ws_connected,
            "closed": sess.closed,
            "close_reason": sess.close_reason,
            "created_at_utc": _utc_iso(sess.created_unix),
            "expires_at_utc": _utc_iso(sess.expires_unix),
            "side_a_language": sess.side_a_language,
            "side_b_language": sess.side_b_language,
            "live_settings": dict(sess.live_settings or {}),
            "tts_settings": dict(sess.tts_settings or {}),
            "voice_cloning": dict(sess.voice_cloning or {"enabled": False}),
            "pc_events_count": len(sess.pc_events),
            "pc_export_path": sess.pc_export_path,
        }


SESSIONS = ConversationSessionManager()


def _remove_session_artifacts(sess: ConversationSession) -> None:
    if sess.pc_export_path:
        _unlink_within(Path(sess.pc_export_path), PC_EXPORT_ROOT)
    _rmtree_within(TTS_ROOT / sess.session_id, TTS_ROOT)
    _rmtree_within(ASR_CHUNKS_ROOT / sess.session_id, ASR_CHUNKS_ROOT)


def _remove_orphaned_artifacts(*, active_session_ids: set[str], cutoff_unix: float) -> None:
    if PC_EXPORT_ROOT.exists():
        for path in PC_EXPORT_ROOT.glob("*.pc"):
            if path.stem in active_session_ids or not _older_than(path, cutoff_unix):
                continue
            _unlink_within(path, PC_EXPORT_ROOT)
    for root in (TTS_ROOT, ASR_CHUNKS_ROOT):
        if not root.exists():
            continue
        for path in root.iterdir():
            if not path.is_dir() or path.name in active_session_ids or not _older_than(path, cutoff_unix):
                continue
            _rmtree_within(path, root)


def _older_than(path: Path, cutoff_unix: float) -> bool:
    try:
        return path.stat().st_mtime <= cutoff_unix
    except OSError:
        return False


def _unlink_within(path: Path, root: Path) -> None:
    try:
        resolved = path.resolve()
        resolved.relative_to(root.resolve())
        resolved.unlink(missing_ok=True)
    except (OSError, ValueError):
        logger.warning("could not remove expired voice artifact %s", path, exc_info=True)


def _rmtree_within(path: Path, root: Path) -> None:
    try:
        resolved = path.resolve()
        resolved.relative_to(root.resolve())
        if resolved.is_dir():
            shutil.rmtree(resolved)
    except (OSError, ValueError):
        logger.warning("could not remove expired voice artifact directory %s", path, exc_info=True)


async def run_voice_session_cleanup_loop() -> None:
    """Remove expired voice session state and its temporary disk artifacts."""
    interval_s = get_int("live.session_cleanup_interval_s", 60, min_value=1)
    while True:
        try:
            await asyncio.to_thread(SESSIONS.cleanup_expired, include_orphans=True)
        except Exception:
            logger.exception("voice session cleanup pass failed")
        await asyncio.sleep(interval_s)
