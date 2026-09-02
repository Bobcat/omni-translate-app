from __future__ import annotations

import asyncio
import contextlib
import re
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlencode

from fastapi import FastAPI, Request, WebSocket
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse, HTMLResponse, RedirectResponse, Response

from app.config import get_str
from app.image_quota import run_image_quota_reconciliation_loop
from app.pdf_reconciliation import run_pdf_reconciliation_loop
from app.router import api_router
from app.routes import websocket_endpoint
from app.runtime import warm_asr_vad
from app.saas_setup import build_saas_router
from app.saas_setup import stage_fresh_anonymous_identity
from app.sessions import run_voice_session_cleanup_loop
from app.upstreams.http import close_upstream_http_client
from app.upstreams.http import open_upstream_http_client
from app.upstreams.tts_pool.client import close_tts_pool_channel
from app.upstreams.tts_pool.client import open_tts_pool_channel
from saas.errors import SaasError
from saas.fastapi_glue import identity_cookie_middleware, saas_error_handler


base_dir = Path(__file__).parent.parent
static_dir = base_dir / "static"

root_path = get_str("service.root_path", "")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    open_upstream_http_client()
    open_tts_pool_channel()
    reconciliation_tasks: list[asyncio.Task] = []
    try:
        await asyncio.to_thread(warm_asr_vad)
        reconciliation_tasks = [
            asyncio.create_task(
                run_pdf_reconciliation_loop(),
                name="pdf-quota-reconciliation",
            ),
            asyncio.create_task(
                run_image_quota_reconciliation_loop(),
                name="image-quota-reconciliation",
            ),
            asyncio.create_task(
                run_voice_session_cleanup_loop(),
                name="voice-session-cleanup",
            ),
        ]
        yield
    finally:
        for task in reconciliation_tasks:
            task.cancel()
        for task in reconciliation_tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        close_upstream_http_client()
        close_tts_pool_channel()


class DevStaticFiles(StaticFiles):
    """HTML is served no-store so page edits always show up. Other assets are
    served no-cache: the browser may keep them but must revalidate every load
    (ETag/Last-Modified → cheap 304s), so unversioned module URLs can never
    go stale. The ?v= query in index.html remains the hard bust after CSS/JS
    changes (see AGENTS.md)."""

    def file_response(self, full_path: str, stat_result, scope, status_code: int = 200) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        if Path(full_path).suffix == ".html":
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


app = FastAPI(
    title="Omni Translate",
    description="Small realtime ASR -> translation -> TTS app.",
    version="0.1.0",
    root_path=root_path,
    lifespan=lifespan,
)

app.include_router(api_router)
app.include_router(build_saas_router())
app.add_exception_handler(SaasError, saas_error_handler)
app.middleware("http")(identity_cookie_middleware)


@app.websocket("/ws/sessions/{session_id}")
async def ws_session(websocket: WebSocket, session_id: str) -> None:
    await websocket_endpoint(websocket, session_id)


# Same pattern as the static index.html files: the landing page must always be
# fresh, and the UA decide per request (Vary so shared caches keep the two
# variants apart).
_LANDING_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Vary": "User-Agent",
}

# Mobile user agents (same regex family as the omniscripta site). Tablets
# reporting a desktop UA (iPadOS sends "Macintosh") get the desktop app; they
# can force the mobile one with ?mobile.
_MOBILE_UA = re.compile(
    r"Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile",
    re.IGNORECASE,
)


@app.get("/", include_in_schema=False)
def landing(request: Request) -> Response:
    """Serve the mobile app or the desktop app on the same URL.

    `?mobile` / `?desktop` force a variant; otherwise the User-Agent decides.
    The desktop index uses relative asset paths, so it gets a <base> pointing
    at /desktop/ — the address bar stays on `/`.
    """
    query = request.query_params
    if "resetguestcredits" in query:
        remaining_query = [
            (key, value)
            for key, value in query.multi_items()
            if key != "resetguestcredits"
        ]
        location = request.url.path
        if remaining_query:
            location = f"{location}?{urlencode(remaining_query)}"
        stage_fresh_anonymous_identity(request)
        return RedirectResponse(location, status_code=303)
    if "mobile" in query:
        want_desktop = False
    elif "desktop" in query:
        want_desktop = True
    else:
        want_desktop = not _MOBILE_UA.search(request.headers.get("user-agent") or "")
    if not want_desktop:
        return FileResponse(static_dir / "index.html", headers=_LANDING_HEADERS)
    html = (static_dir / "desktop" / "index.html").read_text(encoding="utf-8")
    base_href = f"{root_path}/desktop/" if root_path else "/desktop/"
    html = html.replace("<head>", f'<head>\n  <base href="{base_href}">', 1)
    return HTMLResponse(html, headers=_LANDING_HEADERS)


if static_dir.exists():
    app.mount("/", DevStaticFiles(directory=str(static_dir), html=True), name="static")
