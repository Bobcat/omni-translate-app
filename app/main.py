from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles

from app.config import get_str
from app.router import api_router
from app.routes import websocket_endpoint


base_dir = Path(__file__).parent.parent
static_dir = base_dir / "static"

root_path = get_str("service.root_path", "")

app = FastAPI(
    title="ASR Translate TTS",
    description="Small realtime ASR -> translation -> TTS app.",
    version="0.1.0",
    root_path=root_path,
)

app.include_router(api_router)


@app.websocket("/ws/sessions/{session_id}")
async def ws_session(websocket: WebSocket, session_id: str) -> None:
    await websocket_endpoint(websocket, session_id)


if static_dir.exists():
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")

