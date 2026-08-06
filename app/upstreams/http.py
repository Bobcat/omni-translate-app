from __future__ import annotations

import threading

import httpx

from app.config import get_float
from app.config import get_int


_CLIENT: httpx.Client | None = None
_CLIENT_LOCK = threading.Lock()


def open_upstream_http_client() -> httpx.Client:
    """Return the process-wide client, creating its keep-alive pool once."""
    global _CLIENT
    with _CLIENT_LOCK:
        if _CLIENT is None or _CLIENT.is_closed:
            _CLIENT = httpx.Client(
                limits=httpx.Limits(
                    max_connections=get_int("upstream_http.max_connections", 32, min_value=1),
                    max_keepalive_connections=get_int(
                        "upstream_http.max_keepalive_connections",
                        16,
                        min_value=1,
                    ),
                    keepalive_expiry=get_float(
                        "upstream_http.keepalive_expiry_s",
                        60.0,
                        min_value=1.0,
                    ),
                ),
                trust_env=False,
            )
        return _CLIENT


def get_upstream_http_client() -> httpx.Client:
    return open_upstream_http_client()


def close_upstream_http_client() -> None:
    global _CLIENT
    with _CLIENT_LOCK:
        client = _CLIENT
        _CLIENT = None
    if client is not None:
        client.close()
