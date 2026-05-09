from __future__ import annotations

import asyncio
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import patch

from realtime_translation_engine import SourceEvent

from app.asr_pc_export import pc_export_path
from app.runtime import ConversationRuntime
from app.runtime import TurnPart
from app.sessions import ConversationSession
from app.sessions import SESSIONS


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed_code: int | None = None

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)

    async def close(self, *, code: int, reason: str = "") -> None:
        self.closed_code = code


class FastTTS:
    enabled = True

    def __init__(self) -> None:
        self.count = 0

    def synthesize(self, *, session_id: str, text: str, language: str, reference_wav_path: str | None = None) -> dict:
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

    def synthesize(self, *, session_id: str, text: str, language: str, reference_wav_path: str | None = None) -> dict:
        time.sleep(0.2)
        return {
            "artifact_id": "late_artifact",
            "url": "/fake/late.wav",
            "duration_ms": 100,
            "language": language,
            "chars": len(text),
        }


class RecordingTranslationBridge:
    def __init__(self, text: str = "I live downtown") -> None:
        self.text = text
        self.calls: list[str] = []

    def run(self, request) -> SimpleNamespace:
        self.calls.append(request.opportunity.source_window)
        return SimpleNamespace(text=self.text, wall_ms=1.0, model="fake-translation")


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

    async def test_translate_now_accepts_source_preview_and_dispatches_translation(self) -> None:
        runtime, websocket = self.make_runtime(FastTTS())
        lane = runtime._current_lane()
        bridge = RecordingTranslationBridge()
        lane.translation_bridge = bridge

        part = runtime.current_turn.parts[0]
        part.source_committed_text = "Ik woon"
        part.source_preview_text = "in het centrum"
        part.target_committed_text = ""
        lane.source_state.source_committed_text = "Ik woon"
        lane.source_state.source_preview_text = "in het centrum"

        committed_event = SourceEvent(kind="c", text="Ik woon", line_number=1)
        lane.translation_runner.on_source_event(committed_event, lane.source_state)

        await runtime._translate_now()
        task = lane.translation_task
        self.assertIsNotNone(task)
        await task

        self.assertEqual(bridge.calls, ["Ik woon in het centrum"])
        self.assertEqual(part.source_committed_text, "Ik woon in het centrum")
        self.assertEqual(part.source_preview_text, "")
        self.assertEqual(part.target_preview_text, "I live downtown")
        translate_now_update = next(
            event
            for event in websocket.sent
            if event["type"] == "turn_update" and event["reason"] == "translate_now"
        )
        self.assertFalse(translate_now_update["current_turn"]["can_translate_now"])
        translation_update = next(
            event
            for event in websocket.sent
            if event["type"] == "turn_update" and event["reason"] == "translation_update"
        )
        self.assertTrue(translation_update["current_turn"]["can_speak_now"])

    async def test_source_commits_insert_missing_word_boundary_space(self) -> None:
        runtime, _websocket = self.make_runtime(FastTTS())
        lane = runtime._current_lane()
        lane.translation_runner = SimpleNamespace(
            on_source_event=lambda _event, _state: SimpleNamespace(dispatch_request=None)
        )

        await runtime._source_event(lane, kind="c", text="Hallo")
        await runtime._source_event(lane, kind="c", text="wereld")

        part = runtime.current_turn.parts[0]
        self.assertEqual(part.source_committed_text, "Hallo wereld")
        self.assertEqual(runtime._turn_payload(runtime.current_turn)["source_text"], "Hallo wereld")

    async def test_source_commits_do_not_insert_space_before_punctuation(self) -> None:
        runtime, _websocket = self.make_runtime(FastTTS())
        lane = runtime._current_lane()
        lane.translation_runner = SimpleNamespace(
            on_source_event=lambda _event, _state: SimpleNamespace(dispatch_request=None)
        )

        await runtime._source_event(lane, kind="c", text="Hallo")
        await runtime._source_event(lane, kind="c", text=".")

        part = runtime.current_turn.parts[0]
        self.assertEqual(part.source_committed_text, "Hallo.")

    async def test_source_preview_normalizes_whitespace_and_reads_after_committed_text(self) -> None:
        runtime, _websocket = self.make_runtime(FastTTS())
        lane = runtime._current_lane()
        lane.translation_runner = SimpleNamespace(
            on_source_event=lambda _event, _state: SimpleNamespace(dispatch_request=None)
        )

        await runtime._source_event(lane, kind="c", text="Hallo")
        await runtime._source_event(lane, kind="p", text="wereld\nnieuw")

        part = runtime.current_turn.parts[0]
        self.assertEqual(part.source_preview_text, "wereld nieuw")
        self.assertEqual(runtime._turn_payload(runtime.current_turn)["source_text"], "Hallo wereld nieuw")

    async def test_source_event_records_pc_export_event(self) -> None:
        session_payload = SESSIONS.create_session(
            side_a_language="Dutch",
            side_b_language="English",
        )
        session_id = session_payload["session_id"]
        session = SESSIONS.open_websocket(session_id)
        websocket = FakeWebSocket()
        runtime = ConversationRuntime(websocket=websocket, session=session)
        self.runtimes = [*getattr(self, "runtimes", []), runtime]
        path = pc_export_path(session_id)
        try:
            await runtime._source_event(
                runtime._current_lane(),
                kind="p",
                text="Hallo wereld",
                speech_start_ms=100,
                speech_end_ms=900,
                asr_debug={
                    "backend": "faster_whisper_direct",
                    "request_id": "req-1",
                    "segments": [{"segment_id": "s0001", "avg_logprob": -0.2}],
                },
                pc_reason="preview_applied",
            )

            events = SESSIONS.pc_events(session_id)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["kind"], "p")
            self.assertEqual(events[0]["text"], "Hallo wereld")
            self.assertEqual(events[0]["speech_start_ms"], 100)
            self.assertEqual(events[0]["asr_debug"]["backend"], "faster_whisper_direct")
        finally:
            await runtime._cleanup()
            self.runtimes = [item for item in getattr(self, "runtimes", []) if item is not runtime]
            path.unlink(missing_ok=True)

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

    async def test_finish_closes_without_forced_asr_or_translation_drain(self) -> None:
        runtime, websocket = self.make_runtime(FastTTS())
        lane = runtime._current_lane()
        lane.translation_task = asyncio.create_task(asyncio.sleep(60))
        runtime.listening = True

        with (
            patch("app.runtime.SESSIONS.update", return_value={}),
            patch.object(runtime, "_poll_asr_all", new_callable=AsyncMock) as poll_asr,
            patch.object(runtime, "_enqueue_asr", new_callable=AsyncMock) as enqueue_asr,
            patch.object(runtime, "_commit_preview_tail", new_callable=AsyncMock) as commit_tail,
        ):
            await runtime._pause_listening()

        poll_asr.assert_not_awaited()
        enqueue_asr.assert_not_awaited()
        commit_tail.assert_not_awaited()
        self.assertFalse(runtime.listening)
        self.assertIsNone(lane.translation_task)
        self.assertTrue(any(event["type"] == "ended" for event in websocket.sent))
        self.assertIsNotNone(websocket.closed_code)


if __name__ == "__main__":
    unittest.main()
