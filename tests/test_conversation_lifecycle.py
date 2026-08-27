from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import patch

from fastapi import status

from app.voice.session_lifecycle import ConversationLifecycle


class _WebSocket:
    def __init__(self) -> None:
        self.accepted = False
        self.sent: list[dict] = []
        self.closed: tuple[int, str] | None = None

    async def accept(self) -> None:
        self.accepted = True

    async def receive(self) -> dict:
        return {"type": "websocket.disconnect"}

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)

    async def close(self, *, code: int, reason: str = "") -> None:
        self.closed = (code, reason)


class _BlockingWebSocket(_WebSocket):
    async def receive(self) -> dict:
        await asyncio.Future()
        raise AssertionError("unreachable")


class _AsrBridge:
    def __init__(self) -> None:
        self.started = False
        self.closed = False

    def start_completion_stream(self, *, on_terminal_event) -> None:
        self.started = True
        self.on_terminal_event = on_terminal_event

    def close(self) -> None:
        self.closed = True


class _AsrRunner:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error

    def ensure_vad_ready(self) -> None:
        if self.error is not None:
            raise self.error


class _TtsDelivery:
    def __init__(self) -> None:
        self.cleared = False

    def clear(self) -> None:
        self.cleared = True


def _runtime(
    *,
    vad_error: Exception | None = None,
    websocket: _WebSocket | None = None,
) -> SimpleNamespace:
    websocket = websocket or _WebSocket()
    asr_bridge = _AsrBridge()
    lane = SimpleNamespace(
        asr_runner=_AsrRunner(vad_error),
        asr_inflight=None,
        translation_task=None,
        tts_task=None,
        pending_tts={},
    )
    return SimpleNamespace(
        websocket=websocket,
        session_id="conv-lifecycle-test",
        sample_rate_hz=16000,
        channels=1,
        side_a_language="Dutch",
        side_b_language="English",
        live_settings={"asr": {"backend": "test"}},
        tts_settings={"enabled": True, "auto_speak": False},
        lanes={"a_to_b": lane},
        current_turn=object(),
        asr_bridge=asr_bridge,
        tts_delivery=_TtsDelivery(),
        _lane_payload=lambda _lane: {"lane_id": "a_to_b"},
        _turn_payload=lambda _turn: {"turn_id": "turn_1"},
        _process_asr=AsyncMock(),
        _handle_audio=AsyncMock(),
        _handle_control=AsyncMock(return_value=True),
    )


class ConversationLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_disconnect_closes_session_resources(self) -> None:
        runtime = _runtime()
        lifecycle = ConversationLifecycle(runtime)

        with patch("app.voice.session_lifecycle.SESSIONS.close") as close_session:
            await lifecycle.run()

        self.assertTrue(runtime.websocket.accepted)
        self.assertTrue(runtime.asr_bridge.started)
        self.assertTrue(runtime.asr_bridge.closed)
        self.assertTrue(runtime.tts_delivery.cleared)
        self.assertEqual(runtime.websocket.sent[0]["type"], "ready")
        self.assertEqual(
            runtime.websocket.sent[0]["tts_settings"],
            {"enabled": True, "auto_speak": False},
        )
        close_session.assert_called_once_with(runtime.session_id, reason="closed")

    async def test_duration_limit_reports_reason_and_closes_session(self) -> None:
        runtime = _runtime(websocket=_BlockingWebSocket())
        lifecycle = ConversationLifecycle(runtime)
        lifecycle.max_duration_s = 0.01

        with patch("app.voice.session_lifecycle.SESSIONS.close") as close_session:
            await lifecycle.run()

        self.assertEqual(runtime.websocket.sent[-1]["type"], "ended")
        self.assertEqual(runtime.websocket.sent[-1]["reason"], "session_duration_limit")
        self.assertIn("0.01-second", runtime.websocket.sent[-1]["message"])
        self.assertEqual(
            runtime.websocket.closed,
            (status.WS_1000_NORMAL_CLOSURE, ""),
        )
        close_session.assert_called_once_with(
            runtime.session_id,
            reason="session_duration_limit",
        )

    async def test_vad_failure_reports_error_and_still_closes_resources(self) -> None:
        runtime = _runtime(vad_error=RuntimeError("vad unavailable"))
        lifecycle = ConversationLifecycle(runtime)

        with patch("app.voice.session_lifecycle.SESSIONS.close") as close_session:
            await lifecycle.run()

        self.assertFalse(runtime.asr_bridge.started)
        self.assertTrue(runtime.asr_bridge.closed)
        self.assertTrue(runtime.tts_delivery.cleared)
        self.assertEqual(runtime.websocket.sent[0]["code"], "vad_init_failed")
        self.assertEqual(
            runtime.websocket.closed,
            (status.WS_1011_INTERNAL_ERROR, "vad_init_failed"),
        )
        close_session.assert_called_once_with(runtime.session_id, reason="closed")


if __name__ == "__main__":
    unittest.main()
