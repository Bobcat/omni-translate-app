from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from app.config import get_str
from app.router import api_router
from app.routes import websocket_endpoint
from app.runtime import warm_asr_vad
from app.tts_bridge import warm_tts_bridge


base_dir = Path(__file__).parent.parent
static_dir = base_dir / "static"

root_path = get_str("service.root_path", "")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await asyncio.to_thread(warm_asr_vad)
    await warm_tts_bridge()
    yield


class DevStaticFiles(StaticFiles):
    def file_response(self, full_path: Path, stat_result, scope, status_code: int = 200) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response


app = FastAPI(
    title="ASR Translate TTS",
    description="Small realtime ASR -> translation -> TTS app.",
    version="0.1.0",
    root_path=root_path,
    lifespan=lifespan,
)

app.include_router(api_router)


@app.websocket("/ws/sessions/{session_id}")
async def ws_session(websocket: WebSocket, session_id: str) -> None:
    await websocket_endpoint(websocket, session_id)


if static_dir.exists():
    app.mount("/", DevStaticFiles(directory=str(static_dir), html=True), name="static")
