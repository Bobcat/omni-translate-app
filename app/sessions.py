from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from app.config import get_int


def _utc_iso(ts: float) -> str:
    return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()


@dataclass
class ConversationSession:
    session_id: str
    created_unix: float
    expires_unix: float
    source_language: str
    target_language: str
    state: str = "created"
    ws_connected: bool = False
    closed: bool = False
    close_reason: str = ""
    source_revision: int = 0
    target_revision: int = 0
    source_committed_text: str = ""
    target_committed_text: str = ""
    artifacts: list[dict[str, Any]] = field(default_factory=list)


class ConversationSessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, ConversationSession] = {}
        self._lock = threading.Lock()

    def create_session(self, *, source_language: str, target_language: str) -> dict[str, Any]:
        now = time.time()
        ttl_s = get_int("live.session_ttl_s", 900, min_value=60)
        session_id = f"conv_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{secrets.token_hex(4)}"
        sess = ConversationSession(
            session_id=session_id,
            created_unix=now,
            expires_unix=now + ttl_s,
            source_language=str(source_language or "Dutch"),
            target_language=str(target_language or "English"),
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

    def add_artifact(self, session_id: str, artifact: dict[str, Any]) -> None:
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess is not None:
                sess.artifacts.append(dict(artifact))

    def close(self, session_id: str, *, reason: str) -> None:
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None:
                return
            sess.closed = True
            sess.ws_connected = False
            sess.state = "ended"
            sess.close_reason = str(reason or "closed")

    def _cleanup_locked(self, now: float) -> None:
        expired = [
            session_id
            for session_id, sess in self._sessions.items()
            if sess.closed or now >= sess.expires_unix
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
            "source_language": sess.source_language,
            "target_language": sess.target_language,
            "source_revision": int(sess.source_revision),
            "target_revision": int(sess.target_revision),
            "artifacts_count": len(sess.artifacts),
        }


SESSIONS = ConversationSessionManager()
