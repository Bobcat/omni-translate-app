from __future__ import annotations

from fastapi import WebSocket, status

from app.runtime import ConversationRuntime
from app.sessions import SESSIONS


async def websocket_endpoint(websocket: WebSocket, session_id: str) -> None:
    try:
        session = SESSIONS.open_websocket(session_id)
    except KeyError:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="session_not_found")
        return
    except RuntimeError as exc:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason=str(exc))
        return
    runtime = ConversationRuntime(websocket=websocket, session=session)
    await runtime.run()

