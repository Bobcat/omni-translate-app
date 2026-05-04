from __future__ import annotations

import asyncio
import time
import unittest

from app.runtime import ConversationRuntime
from app.runtime import TurnPart
from app.sessions import ConversationSession


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class FastTTS:
    enabled = True

    def __init__(self) -> None:
        self.count = 0

    def synthesize(self, *, session_id: str, text: str, language: str) -> dict:
        self.count += 1
        return {
            "artifact_id": f"artifact_{self.count}",
            "url": f"/fake/{self.count}.wav",
            "duration_ms": 100,
            "language": language,
            "chars": len(text),
        }


class SlowTTS:
    enabled = True

    def synthesize(self, *, session_id: str, text: str, language: str) -> dict:
        time.sleep(0.2)
        return {
            "artifact_id": "late_artifact",
            "url": "/fake/late.wav",
            "duration_ms": 100,
            "language": language,
            "chars": len(text),
        }


class TurnStateMachineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self) -> None:
        runtimes = getattr(self, "runtimes", [])
        for runtime in runtimes:
            await runtime._cleanup()

    def make_runtime(self, tts: FastTTS | SlowTTS | None = None) -> tuple[ConversationRuntime, FakeWebSocket]:
        session = ConversationSession(
            session_id=f"conv_test_{time.time_ns()}",
            created_unix=time.time(),
            expires_unix=time.time() + 60,
            side_a_language="Dutch",
            side_b_language="English",
        )
        websocket = FakeWebSocket()
        runtime = ConversationRuntime(websocket=websocket, session=session)
        runtime.tts_bridge = tts or FastTTS()
        runtime.current_turn.parts.append(
            TurnPart(
                part_id="turn_1_part_1",
                source_committed_text="Test",
                target_committed_text="Test",
            )
        )
        runtime._refresh_turn_state()
        self.runtimes = [*getattr(self, "runtimes", []), runtime]
        return runtime, websocket

    async def test_speak_now_and_playback_complete_marks_part_spoken(self) -> None:
        runtime, websocket = self.make_runtime(FastTTS())

        await runtime._speak_now()
        tts_task = runtime._current_lane().tts_task
        self.assertIsNotNone(tts_task)
        self.assertEqual(runtime.current_turn.state.value, "open_speaking")
        self.assertEqual([part.speech_state for part in runtime.current_turn.parts], ["speaking"])

        await tts_task
        self.assertIsNotNone(runtime._current_lane().pending_tts)
        self.assertTrue(any(event["type"] == "tts_clip_ready" for event in websocket.sent))

        await runtime._tts_playback_complete(
            {
                "lane_id": "a_to_b",
                "turn_id": runtime.current_turn.turn_id,
                "artifact_id": "artifact_1",
            }
        )

        self.assertEqual(runtime.current_turn.state.value, "open_spoken_idle")
        self.assertEqual([part.speech_state for part in runtime.current_turn.parts], ["spoken"])
        self.assertEqual(runtime._turn_payload(runtime.current_turn)["speakable_target_text"], "")

        next_part = runtime._current_writable_part()
        self.assertEqual(next_part.part_id, "turn_1_part_2")
        self.assertEqual(len(runtime.current_turn.parts), 2)

    async def test_speak_now_accepts_visible_preview_text(self) -> None:
        runtime, websocket = self.make_runtime(FastTTS())
        lane = runtime._current_lane()
        part = runtime.current_turn.parts[0]
        part.source_committed_text = "Ik woon"
        part.source_preview_text = "in het centrum"
        part.target_committed_text = ""
        part.target_preview_text = "I live downtown"
        lane.source_state.source_committed_text = "Ik woon"
        lane.source_state.source_preview_text = "in het centrum"
        lane.translation_runner.target_state.target_preview_text = "I live downtown"
        runtime._refresh_turn_state()

        await runtime._speak_now()

        self.assertEqual(part.source_committed_text, "Ik woon in het centrum")
        self.assertEqual(part.source_preview_text, "")
        self.assertEqual(part.target_committed_text, "I live downtown")
        self.assertEqual(part.target_preview_text, "")
        speak_now_update = next(
            event
            for event in websocket.sent
            if event["type"] == "turn_update" and event["reason"] == "speak_now"
        )
        payload_part = speak_now_update["current_turn"]["parts"][0]
        self.assertEqual(payload_part["source_committed_text"], "Ik woon in het centrum")
        self.assertEqual(payload_part["source_preview_text"], "")

    async def test_clear_turn_while_tts_is_pending_discards_turn_and_drops_late_audio(self) -> None:
        runtime, websocket = self.make_runtime(SlowTTS())

        await runtime._speak_now()
        old_turn_id = runtime.current_turn.turn_id
        self.assertEqual(runtime.current_turn.state.value, "open_speaking")

        await runtime._clear_turn()
        await asyncio.sleep(0.3)
        await runtime._tts_playback_complete(
            {
                "lane_id": "a_to_b",
                "turn_id": old_turn_id,
                "artifact_id": "late_artifact",
            }
        )

        self.assertEqual(runtime.current_turn.turn_id, "turn_2")
        self.assertEqual(runtime.current_turn.lane_id, "a_to_b")
        self.assertEqual(runtime.current_turn.state.value, "open_empty")
        self.assertEqual(runtime.current_turn.parts, [])
        self.assertEqual(len(runtime.discarded_turns), 1)
        self.assertIsNone(runtime.lanes["a_to_b"].pending_tts)
        self.assertFalse(any(event["type"] == "tts_clip_ready" for event in websocket.sent))

    async def test_next_turn_while_tts_is_pending_closes_turn_and_drops_late_audio(self) -> None:
        runtime, websocket = self.make_runtime(SlowTTS())

        await runtime._speak_now()
        old_turn_id = runtime.current_turn.turn_id
        self.assertEqual(runtime.current_turn.state.value, "open_speaking")

        await runtime._next_turn(lane_id="b_to_a")
        await asyncio.sleep(0.3)
        await runtime._tts_playback_complete(
            {
                "lane_id": "a_to_b",
                "turn_id": old_turn_id,
                "artifact_id": "late_artifact",
            }
        )

        self.assertEqual(runtime.current_turn.turn_id, "turn_2")
        self.assertEqual(runtime.current_turn.lane_id, "b_to_a")
        self.assertEqual(runtime.current_turn.state.value, "open_empty")
        self.assertEqual(runtime.current_turn.parts, [])
        self.assertEqual(len(runtime.closed_turns), 1)
        self.assertIsNone(runtime.lanes["a_to_b"].pending_tts)
        self.assertFalse(any(event["type"] == "tts_clip_ready" for event in websocket.sent))


if __name__ == "__main__":
    unittest.main()
