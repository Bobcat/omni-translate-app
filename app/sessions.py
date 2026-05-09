from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime, timezone
from typing import Any

from app.asr_pc_export import live_pc_events_to_text
from app.asr_pc_export import pc_export_path
from app.config import get_int
from app.live_settings import default_live_settings


def _utc_iso(ts: float) -> str:
    return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()


@dataclass
class ConversationSession:
    session_id: str
    created_unix: float
    expires_unix: float
    side_a_language: str
    side_b_language: str
    state: str = "created"
    ws_connected: bool = False
    closed: bool = False
    close_reason: str = ""
    live_settings: dict[str, Any] = field(default_factory=default_live_settings)
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
        live_settings: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = time.time()
        ttl_s = get_int("live.session_ttl_s", 900, min_value=60)
        session_id = f"conv_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{secrets.token_hex(4)}"
        sess = ConversationSession(
            session_id=session_id,
            created_unix=now,
            expires_unix=now + ttl_s,
            side_a_language=str(side_a_language or "Dutch"),
            side_b_language=str(side_b_language or "English"),
            live_settings=dict(live_settings or default_live_settings()),
        )
        with self._lock:
            self._cleanup_locked(now)
            self._sessions[session_id] = sess
            return self._payload_locked(sess)

    def open_websocket(self, session_id: str) -> ConversationSession:
        now = time.time()
        with self._lock:
            self._cleanup_locked(now)
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

    def _cleanup_locked(self, now: float) -> None:
        expired = [
            session_id
            for session_id, sess in self._sessions.items()
            if now >= sess.expires_unix
        ]
        for session_id in expired:
            self._sessions.pop(session_id, None)

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
            "pc_events_count": len(sess.pc_events),
            "pc_export_path": sess.pc_export_path,
        }


SESSIONS = ConversationSessionManager()
