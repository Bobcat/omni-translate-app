from __future__ import annotations

import asyncio
import threading
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
from app.tts_bridge import tts_settings_snapshot
from app.voice.session_storage import SessionArtifactLimitExceeded


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed_code: int | None = None

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)

    async def close(self, *, code: int, reason: str = "") -> None:
        self.closed_code = code


class SuspendingChunkWebSocket(FakeWebSocket):
    def __init__(self) -> None:
        super().__init__()
        self.first_chunk_send_started = asyncio.Event()
        self.release_first_chunk_send = asyncio.Event()

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)
        if (
            payload.get("type") == "tts_stream_chunk"
            and payload.get("sequence_number") == 0
            and not self.first_chunk_send_started.is_set()
        ):
            self.first_chunk_send_started.set()
            await self.release_first_chunk_send.wait()


class FailingCompleteWebSocket(FakeWebSocket):
    def __init__(self) -> None:
        super().__init__()
        self.failed = False

    async def send_json(self, payload: dict) -> None:
        if payload.get("type") == "tts_stream_complete" and not self.failed:
            self.failed = True
            raise RuntimeError("simulated websocket send failure")
        self.sent.append(payload)


class FastTTS:
    enabled = True

    def __init__(self) -> None:
        self.count = 0
        self.settings: list[dict | None] = []
        self.fairness_keys: list[str] = []

    def synthesize(self, *, session_id: str, text: str, language: str, fairness_key: str, settings: dict | None = None, reference_wav_path: str | None = None, reference_prompt_text: str | None = None, source_audio_duration_ms: int | None = None, on_stream_started=None, on_audio_chunk=None, cancellation=None) -> dict:
        self.count += 1
        self.settings.append(settings)
        self.fairness_keys.append(fairness_key)
        payload = {
            "artifact_id": f"artifact_{self.count}",
            "url": f"/fake/{self.count}.wav",
            "duration_ms": 100,
            "language": language,
            "chars": len(text),
        }
        if on_stream_started is not None:
            on_stream_started(
                {
                    "artifact_id": payload["artifact_id"],
                    "sample_rate_hz": 24_000,
                    "channel_count": 1,
                    "encoding": "pcm_s16le",
                }
            )
        if on_audio_chunk is not None:
            on_audio_chunk(
                {
                    "artifact_id": payload["artifact_id"],
                    "sequence_number": 0,
                    "first_sample": 0,
                    "pcm": b"\x00\x00" * 2400,
                }
            )
        return payload


class StorageLimitTTS:
    enabled = True

    def synthesize(self, **_kwargs) -> dict:
        raise SessionArtifactLimitExceeded(
            limit_bytes=256 * 1024 * 1024,
            used_bytes=256 * 1024 * 1024,
            requested_bytes=1024,
        )


class SlowTTS:
    enabled = True

    def synthesize(self, *, session_id: str, text: str, language: str, fairness_key: str, settings: dict | None = None, reference_wav_path: str | None = None, reference_prompt_text: str | None = None, source_audio_duration_ms: int | None = None, on_stream_started=None, on_audio_chunk=None, cancellation=None) -> dict:
        payload = {
            "artifact_id": "late_artifact",
            "url": "/fake/late.wav",
            "duration_ms": 100,
            "language": language,
            "chars": len(text),
        }
        if on_stream_started is not None:
            on_stream_started(
                {
                    "artifact_id": payload["artifact_id"],
                    "sample_rate_hz": 24_000,
                    "channel_count": 1,
                    "encoding": "pcm_s16le",
                }
            )
        if on_audio_chunk is not None:
            on_audio_chunk(
                {
                    "artifact_id": payload["artifact_id"],
                    "sequence_number": 0,
                    "first_sample": 0,
                    "pcm": b"\x00\x00" * 2400,
                }
            )
        time.sleep(0.2)
        return payload


class BlockingTTS:
    enabled = True

    def __init__(self) -> None:
        self.started = threading.Event()
        self.cancelled = threading.Event()

    def synthesize(self, *, cancellation=None, **_kwargs) -> dict:
        self.started.set()
        while cancellation is not None and not cancellation.cancelled:
            time.sleep(0.001)
        self.cancelled.set()
        raise RuntimeError("cancelled")


class LateStartTTS:
    enabled = True

    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()

    def synthesize(self, *, on_stream_started=None, cancellation=None, **_kwargs) -> dict:
        self.entered.set()
        self.release.wait(timeout=1.0)
        payload = {
            "artifact_id": "late_start_artifact",
            "url": "/fake/late-start.wav",
            "duration_ms": 100,
        }
        if on_stream_started is not None:
            on_stream_started(
                {
                    "artifact_id": payload["artifact_id"],
                    "sample_rate_hz": 24_000,
                    "channel_count": 1,
                    "encoding": "pcm_s16le",
                }
            )
        return payload


class BufferedTTS:
    enabled = True

    def __init__(self) -> None:
        self.count = 0
        self.chunk_ready = threading.Event()
        self.release = threading.Event()

    def synthesize(self, *, on_stream_started=None, on_audio_chunk=None, cancellation=None, **_kwargs) -> dict:
        self.count += 1
        payload = {
            "artifact_id": f"buffered_{self.count}",
            "url": f"/fake/buffered-{self.count}.wav",
            "duration_ms": 100,
        }
        if on_stream_started is not None:
            on_stream_started(
                {
                    "artifact_id": payload["artifact_id"],
                    "sample_rate_hz": 24_000,
                    "channel_count": 1,
                    "encoding": "pcm_s16le",
                }
            )
        if on_audio_chunk is not None:
            on_audio_chunk(
                {
                    "artifact_id": payload["artifact_id"],
                    "sequence_number": 0,
                    "first_sample": 0,
                    "pcm": b"\x00\x00" * 2400,
                }
            )
        self.chunk_ready.set()
        while not self.release.wait(0.001):
            if cancellation is not None and cancellation.cancelled:
                raise RuntimeError("cancelled")
        return payload


class InterleavingTTS:
    enabled = True

    def __init__(self) -> None:
        self.chunk_ready = threading.Event()
        self.release = threading.Event()

    def synthesize(self, *, on_stream_started=None, on_audio_chunk=None, cancellation=None, **_kwargs) -> dict:
        payload = {
            "artifact_id": "interleaving_artifact",
            "url": "/fake/interleaving.wav",
            "duration_ms": 100,
        }
        if on_stream_started is not None:
            on_stream_started(
                {
                    "artifact_id": payload["artifact_id"],
                    "sample_rate_hz": 24_000,
                    "channel_count": 1,
                    "encoding": "pcm_s16le",
                }
            )
        for sequence_number in range(3):
            on_audio_chunk(
                {
                    "artifact_id": payload["artifact_id"],
                    "sequence_number": sequence_number,
                    "first_sample": sequence_number * 2400,
                    "pcm": b"\x00\x00" * 2400,
                }
            )
        self.chunk_ready.set()
        while not self.release.wait(0.001):
            if cancellation is not None and cancellation.cancelled:
                raise RuntimeError("cancelled")
        for sequence_number in range(3, 6):
            on_audio_chunk(
                {
                    "artifact_id": payload["artifact_id"],
                    "sequence_number": sequence_number,
                    "first_sample": sequence_number * 2400,
                    "pcm": b"\x00\x00" * 2400,
                }
            )
        return payload


class PriorityTTS:
    enabled = True

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.speculation_started = threading.Event()
        self.speculation_cancelled = threading.Event()

    def synthesize(
        self,
        *,
        text: str,
        language: str,
        on_stream_started=None,
        on_audio_chunk=None,
        cancellation=None,
        **_kwargs,
    ) -> dict:
        self.calls.append(text)
        if len(self.calls) == 1:
            self.speculation_started.set()
            while cancellation is not None and not cancellation.cancelled:
                time.sleep(0.001)
            self.speculation_cancelled.set()
            raise RuntimeError("cancelled")
        payload = {
            "artifact_id": "demand_artifact",
            "url": "/fake/demand.wav",
            "duration_ms": 100,
            "language": language,
        }
        if on_stream_started is not None:
            on_stream_started(
                {
                    "artifact_id": payload["artifact_id"],
                    "sample_rate_hz": 24_000,
                    "channel_count": 1,
                    "encoding": "pcm_s16le",
                }
            )
        if on_audio_chunk is not None:
            on_audio_chunk(
                {
                    "artifact_id": payload["artifact_id"],
                    "sequence_number": 0,
                    "first_sample": 0,
                    "pcm": b"\x00\x00" * 2400,
                }
            )
        return payload


class RecordingTranslationBridge:
    def __init__(self, text: str = "I live downtown") -> None:
        self.text = text
        self.calls: list[str] = []

    def run(self, request) -> SimpleNamespace:
        self.calls.append(request.opportunity.source_window)
        return SimpleNamespace(
            text=self.text,
            wall_ms=1.0,
            profile="general-fast:test",
            quality="fast",
        )


class TurnStateMachineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self) -> None:
        runtimes = getattr(self, "runtimes", [])
        for runtime in runtimes:
            await runtime.lifecycle.close()

    def make_runtime(
        self,
        tts: FastTTS | SlowTTS | None = None,
        *,
        auto_speak: bool = False,
        speculation_limit: int = 8,
        websocket: FakeWebSocket | None = None,
    ) -> tuple[ConversationRuntime, FakeWebSocket]:
        session = ConversationSession(
            session_id=f"conv_test_{time.time_ns()}",
            created_unix=time.time(),
            expires_unix=time.time() + 60,
            side_a_language="Dutch",
            side_b_language="English",
            tts_fairness_key="principal_test",
            tts_settings=tts_settings_snapshot(
                {"enabled": True, "auto_speak": auto_speak}
            )[0],
        )
        websocket = websocket or FakeWebSocket()
        with patch(
            "app.voice.tts_delivery.get_int",
            return_value=speculation_limit,
        ):
            runtime = ConversationRuntime(websocket=websocket, session=session)
        runtime.tts_delivery.bridge = tts or FastTTS()
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

    async def test_speculation_stops_after_the_configured_bubble_limit(self) -> None:
        tts = FastTTS()
        runtime, websocket = self.make_runtime(tts, speculation_limit=2)
        for index in range(2, 4):
            runtime.current_turn.parts.append(
                TurnPart(
                    part_id=f"turn_1_part_{index}",
                    source_committed_text=f"Bron {index}",
                    target_committed_text=f"Target {index}",
                )
            )
        for part in runtime.current_turn.parts:
            part.is_closed = True

        accepted = [
            runtime.tts_delivery.prepare_definitive_part(
                lane_id="a_to_b",
                turn_id=runtime.current_turn.turn_id,
                part_id=part.part_id,
            )
            for part in runtime.current_turn.parts
        ]
        await runtime.tts_delivery.generation_task

        self.assertEqual(accepted, [True, True, False])
        self.assertEqual(tts.count, 2)
        self.assertEqual(runtime.tts_delivery.speculation_budget, 0)
        self.assertFalse(any(item["type"].startswith("tts_stream_") for item in websocket.sent))
        self.assertEqual(
            [part.speech_state for part in runtime.current_turn.parts],
            ["pending", "pending", "pending"],
        )

    async def test_speak_uses_a_ready_speculative_artifact_and_resets_budget(self) -> None:
        tts = FastTTS()
        runtime, websocket = self.make_runtime(tts, speculation_limit=1)
        part = runtime.current_turn.parts[0]
        part.is_closed = True
        self.assertTrue(
            runtime.tts_delivery.prepare_definitive_part(
                lane_id="a_to_b",
                turn_id=runtime.current_turn.turn_id,
                part_id=part.part_id,
            )
        )
        await runtime.tts_delivery.generation_task

        await runtime._speak_part(part.part_id)
        await runtime._current_lane().tts_task

        self.assertEqual(tts.count, 1)
        self.assertEqual(runtime.tts_delivery.speculation_budget, 1)
        ready = next(item for item in websocket.sent if item["type"] == "tts_artifact_ready")
        self.assertEqual(ready["playback_kind"], "first")
        self.assertEqual(ready["playback_trigger"], "explicit")
        self.assertEqual(ready["tts"]["artifact_id"], "artifact_1")

    async def test_tts_storage_limit_ends_the_voice_session(self) -> None:
        runtime, websocket = self.make_runtime(StorageLimitTTS())
        part = runtime.current_turn.parts[0]

        await runtime._speak_part(part.part_id)
        await runtime._current_lane().tts_task

        ended = [item for item in websocket.sent if item["type"] == "ended"]
        self.assertEqual(ended[-1]["reason"], "session_storage_limit")
        self.assertIn("256 MiB", ended[-1]["message"])
        self.assertTrue(runtime.lifecycle.closed)
        self.assertIsNotNone(websocket.closed_code)
        self.assertFalse(any(item.get("code") == "tts_failed" for item in websocket.sent))

    async def test_asr_storage_limit_ends_the_voice_session(self) -> None:
        runtime, websocket = self.make_runtime()
        lane = runtime._current_lane()
        runtime.lifecycle.listening = True
        work = SimpleNamespace(
            sequence_id=1,
            t0_ms=0,
            t1_ms=500,
            pcm16le=b"\0\0" * 8000,
        )
        decision = SimpleNamespace(
            error=None,
            speech_gate_decision=None,
            speech_observation=None,
            work_decision=SimpleNamespace(work_item=work),
        )
        limit_error = SessionArtifactLimitExceeded(
            limit_bytes=256 * 1024 * 1024,
            used_bytes=256 * 1024 * 1024,
            requested_bytes=len(work.pcm16le),
        )

        with (
            patch.object(lane.asr_runner, "maybe_dispatch_work", return_value=decision),
            patch.object(lane.asr_runner, "rollback_inflight_work") as rollback,
            patch.object(runtime.asr_bridge, "enqueue_pcm16", side_effect=limit_error),
        ):
            await runtime._enqueue_asr(lane, force=False)

        rollback.assert_called_once_with(sequence_id=work.sequence_id)
        ended = [item for item in websocket.sent if item["type"] == "ended"]
        self.assertEqual(ended[-1]["reason"], "session_storage_limit")
        self.assertTrue(runtime.lifecycle.closed)
        self.assertIsNotNone(websocket.closed_code)
        self.assertFalse(any(item.get("code") == "asr_submit_failed" for item in websocket.sent))

    async def test_speak_joins_buffered_speculative_generation(self) -> None:
        tts = BufferedTTS()
        runtime, websocket = self.make_runtime(tts, speculation_limit=1)
        part = runtime.current_turn.parts[0]
        part.is_closed = True
        runtime.tts_delivery.prepare_definitive_part(
            lane_id="a_to_b",
            turn_id=runtime.current_turn.turn_id,
            part_id=part.part_id,
        )
        self.assertTrue(await asyncio.to_thread(tts.chunk_ready.wait, 1.0))

        await runtime._speak_part(part.part_id)
        await asyncio.sleep(0.01)
        event_types = [item["type"] for item in websocket.sent]
        self.assertIn("tts_stream_started", event_types)
        self.assertIn("tts_stream_chunk", event_types)
        self.assertEqual(tts.count, 1)
        self.assertFalse(
            runtime.tts_delivery.preparations[
                (runtime.current_turn.turn_id, part.part_id)
            ].chunks
        )

        tts.release.set()
        await runtime._current_lane().tts_task
        self.assertTrue(any(item["type"] == "tts_stream_complete" for item in websocket.sent))

    async def test_speak_join_preserves_chunk_order_while_new_chunks_arrive(self) -> None:
        tts = InterleavingTTS()
        websocket = SuspendingChunkWebSocket()
        runtime, _ = self.make_runtime(
            tts,
            speculation_limit=1,
            websocket=websocket,
        )
        part = runtime.current_turn.parts[0]
        part.is_closed = True
        runtime.tts_delivery.prepare_definitive_part(
            lane_id="a_to_b",
            turn_id=runtime.current_turn.turn_id,
            part_id=part.part_id,
        )
        self.assertTrue(await asyncio.to_thread(tts.chunk_ready.wait, 1.0))

        await runtime._speak_part(part.part_id)
        await asyncio.wait_for(websocket.first_chunk_send_started.wait(), timeout=1.0)
        tts.release.set()
        await asyncio.sleep(0.01)
        websocket.release_first_chunk_send.set()
        await asyncio.wait_for(runtime._current_lane().tts_task, timeout=1.0)

        sequences = [
            item["sequence_number"]
            for item in websocket.sent
            if item["type"] == "tts_stream_chunk"
        ]
        self.assertEqual(sequences, list(range(6)))

    async def test_send_failure_does_not_strand_the_generation_queue(self) -> None:
        tts = BufferedTTS()
        websocket = FailingCompleteWebSocket()
        runtime, _ = self.make_runtime(
            tts,
            speculation_limit=2,
            websocket=websocket,
        )
        first = runtime.current_turn.parts[0]
        first.is_closed = True
        second = TurnPart(
            part_id="turn_1_part_2",
            source_committed_text="Tweede",
            target_committed_text="Second",
            is_closed=True,
        )
        runtime.current_turn.parts.append(second)
        for part in (first, second):
            self.assertTrue(
                runtime.tts_delivery.prepare_definitive_part(
                    lane_id="a_to_b",
                    turn_id=runtime.current_turn.turn_id,
                    part_id=part.part_id,
                )
            )
        self.assertTrue(await asyncio.to_thread(tts.chunk_ready.wait, 1.0))

        await runtime._speak_part(first.part_id)
        tts.release.set()
        speak_task = runtime._current_lane().tts_task
        generation_task = runtime.tts_delivery.generation_task
        await asyncio.wait_for(speak_task, timeout=1.0)
        await asyncio.wait_for(generation_task, timeout=1.0)

        first_record = runtime.tts_delivery.preparations[(runtime.current_turn.turn_id, first.part_id)]
        second_record = runtime.tts_delivery.preparations[(runtime.current_turn.turn_id, second.part_id)]
        self.assertTrue(websocket.failed)
        self.assertEqual(first_record.state, "failed")
        self.assertTrue(first_record.done.done())
        self.assertEqual(first.speech_state, "pending")
        self.assertTrue(
            any(
                item["type"] == "tts_stream_failed"
                and item["artifact_id"] == "buffered_1"
                for item in websocket.sent
            )
        )
        self.assertTrue(
            any(
                item["type"] == "turn_update" and item["reason"] == "tts_failed"
                for item in websocket.sent
            )
        )
        self.assertEqual(second_record.state, "ready")
        self.assertTrue(second_record.done.done())
        self.assertFalse(runtime.tts_delivery.generation_queue)

    async def test_explicit_demand_preempts_unrelated_speculation(self) -> None:
        tts = PriorityTTS()
        runtime, websocket = self.make_runtime(tts, speculation_limit=1)
        first = runtime.current_turn.parts[0]
        first.is_closed = True
        second = TurnPart(
            part_id="turn_1_part_2",
            source_committed_text="Tweede",
            target_committed_text="Second",
            is_closed=True,
        )
        runtime.current_turn.parts.append(second)
        runtime.tts_delivery.prepare_definitive_part(
            lane_id="a_to_b",
            turn_id=runtime.current_turn.turn_id,
            part_id=first.part_id,
        )
        self.assertTrue(await asyncio.to_thread(tts.speculation_started.wait, 1.0))

        await runtime._speak_part(second.part_id)
        await runtime._current_lane().tts_task

        self.assertTrue(tts.speculation_cancelled.is_set())
        self.assertEqual(tts.calls, ["Test", "Second"])
        started = [item for item in websocket.sent if item["type"] == "tts_stream_started"]
        self.assertEqual(started[-1]["part_ids"], [second.part_id])

    async def test_synthesis_setting_change_invalidates_prepared_audio(self) -> None:
        runtime, _websocket = self.make_runtime(FastTTS(), speculation_limit=1)
        part = runtime.current_turn.parts[0]
        part.is_closed = True
        runtime.tts_delivery.prepare_definitive_part(
            lane_id="a_to_b",
            turn_id=runtime.current_turn.turn_id,
            part_id=part.part_id,
        )
        await runtime.tts_delivery.generation_task
        self.assertTrue(runtime.tts_delivery.preparations)

        previous = runtime.tts_settings
        current = {**previous, "backend": "changed_for_test"}
        runtime.tts_settings = current
        await runtime.tts_delivery.settings_changed(previous, current)

        self.assertFalse(runtime.tts_delivery.preparations)

    async def test_auto_speak_ignores_zero_speculation_budget(self) -> None:
        tts = FastTTS()
        runtime, websocket = self.make_runtime(
            tts,
            auto_speak=True,
            speculation_limit=0,
        )
        part = runtime.current_turn.parts[0]

        await runtime._close_current_bubble(
            runtime._current_lane(),
            reason="sentence_boundary",
        )
        await runtime._current_lane().tts_task

        self.assertTrue(part.is_closed)
        self.assertEqual(part.speech_state, "speaking")
        self.assertEqual(tts.count, 1)
        started = next(item for item in websocket.sent if item["type"] == "tts_stream_started")
        self.assertEqual(started["playback_trigger"], "automatic")
        self.assertTrue(any(item["type"] == "tts_stream_chunk" for item in websocket.sent))

    async def test_disabling_auto_speak_cancels_unstarted_automatic_generation(self) -> None:
        tts = BlockingTTS()
        runtime, _websocket = self.make_runtime(tts, auto_speak=True)
        part = runtime.current_turn.parts[0]
        await runtime._close_current_bubble(
            runtime._current_lane(),
            reason="sentence_boundary",
        )
        self.assertTrue(await asyncio.to_thread(tts.started.wait, 1.0))

        with patch("app.runtime.SESSIONS.update", return_value={}):
            await runtime._update_tts_settings(
                {"settings": {**runtime.tts_settings, "auto_speak": False}}
            )

        self.assertTrue(await asyncio.to_thread(tts.cancelled.wait, 1.0))
        self.assertEqual(part.speech_state, "pending")
        self.assertFalse(runtime.tts_delivery.preparations)

    async def test_enabling_auto_speak_does_not_play_the_existing_backlog(self) -> None:
        tts = FastTTS()
        runtime, websocket = self.make_runtime(tts, speculation_limit=1)
        first = runtime.current_turn.parts[0]
        await runtime._close_current_bubble(
            runtime._current_lane(),
            reason="sentence_boundary",
        )
        await runtime.tts_delivery.generation_task
        self.assertEqual(tts.count, 1)
        self.assertFalse(any(item["type"].startswith("tts_stream_") for item in websocket.sent))

        with patch("app.runtime.SESSIONS.update", return_value={}):
            await runtime._update_tts_settings(
                {"settings": {**runtime.tts_settings, "auto_speak": True}}
            )
        self.assertEqual(first.speech_state, "pending")
        self.assertIn((runtime.current_turn.turn_id, first.part_id), runtime.tts_delivery.preparations)
        self.assertFalse(any(item["type"] == "tts_artifact_ready" for item in websocket.sent))

        second = TurnPart(
            part_id="turn_1_part_2",
            source_committed_text="Tweede",
            target_committed_text="Second",
        )
        runtime.current_turn.parts.append(second)
        await runtime._close_current_bubble(
            runtime._current_lane(),
            reason="sentence_boundary",
        )
        await runtime._current_lane().tts_task

        self.assertEqual(tts.count, 2)
        self.assertEqual(first.speech_state, "pending")
        self.assertEqual(second.speech_state, "speaking")
        started = [item for item in websocket.sent if item["type"] == "tts_stream_started"]
        self.assertEqual(started[-1]["part_ids"], [second.part_id])

    async def test_auto_speak_handles_subsequent_bubbles_in_order(self) -> None:
        tts = FastTTS()
        runtime, websocket = self.make_runtime(tts, auto_speak=True)
        first = runtime.current_turn.parts[0]
        await runtime._close_current_bubble(
            runtime._current_lane(),
            reason="sentence_boundary",
        )
        await runtime._current_lane().tts_task
        await runtime.tts_delivery.playback_complete(
            {
                "lane_id": "a_to_b",
                "turn_id": runtime.current_turn.turn_id,
                "artifact_id": "artifact_1",
            }
        )

        second = TurnPart(
            part_id="turn_1_part_2",
            source_committed_text="Tweede",
            target_committed_text="Second",
        )
        runtime.current_turn.parts.append(second)
        await runtime._close_current_bubble(
            runtime._current_lane(),
            reason="sentence_boundary",
        )
        await runtime._current_lane().tts_task

        self.assertEqual(first.speech_state, "spoken")
        self.assertEqual(second.speech_state, "speaking")
        self.assertEqual(tts.count, 2)
        started = [
            item["tts"]["artifact_id"]
            for item in websocket.sent
            if item["type"] == "tts_stream_started"
        ]
        self.assertEqual(started, ["artifact_1", "artifact_2"])

    async def test_auto_speak_closed_preview_does_not_prefix_the_next_translation(self) -> None:
        runtime, _websocket = self.make_runtime(FastTTS(), auto_speak=True)
        lane = runtime._current_lane()
        first = runtime.current_turn.parts[0]
        first.source_committed_text = "hallo hallo"
        first.target_committed_text = ""
        first.target_preview_text = "hello hello"
        first.is_closed = True
        runtime._reset_lane_text_scope(lane)

        await runtime._dispatch_speak_sequence([first.part_id], reason="auto_speak")
        await lane.tts_task
        preparation = runtime.tts_delivery.preparations[(runtime.current_turn.turn_id, first.part_id)]
        await runtime.tts_delivery.playback_complete(
            {
                "lane_id": lane.lane_id,
                "turn_id": runtime.current_turn.turn_id,
                "artifact_id": preparation.artifact_id,
            }
        )

        self.assertEqual(lane.translation_runner.target_state.target_committed_text, "")
        bridge = RecordingTranslationBridge(text="This is nice work.")
        lane.translation_bridge = bridge
        await runtime._source_event(lane, kind="c", text="Leuk werk is dit.")

        second = runtime.current_turn.parts[-1]
        self.assertEqual(bridge.calls, ["Leuk werk is dit."])
        self.assertEqual(second.source_committed_text, "Leuk werk is dit.")
        self.assertEqual(second.target_committed_text, "This is nice work.")

    async def test_disabling_auto_speak_keeps_new_bubbles_silent(self) -> None:
        tts = FastTTS()
        runtime, websocket = self.make_runtime(tts, auto_speak=True)
        await runtime._close_current_bubble(
            runtime._current_lane(),
            reason="sentence_boundary",
        )
        await runtime._current_lane().tts_task
        await runtime.tts_delivery.playback_complete(
            {
                "lane_id": "a_to_b",
                "turn_id": runtime.current_turn.turn_id,
                "artifact_id": "artifact_1",
            }
        )
        with patch("app.runtime.SESSIONS.update", return_value={}):
            await runtime._update_tts_settings(
                {"settings": {**runtime.tts_settings, "auto_speak": False}}
            )

        second = TurnPart(
            part_id="turn_1_part_2",
            source_committed_text="Tweede",
            target_committed_text="Second",
        )
        runtime.current_turn.parts.append(second)
        await runtime._close_current_bubble(
            runtime._current_lane(),
            reason="sentence_boundary",
        )
        await runtime.tts_delivery.generation_task

        self.assertEqual(tts.count, 2)
        self.assertEqual(second.speech_state, "pending")
        started = [item for item in websocket.sent if item["type"] == "tts_stream_started"]
        self.assertEqual(len(started), 1)

    async def test_speak_now_and_playback_complete_marks_part_spoken(self) -> None:
        runtime, websocket = self.make_runtime(FastTTS())

        await runtime._speak_now()
        tts_task = runtime._current_lane().tts_task
        self.assertIsNotNone(tts_task)
        self.assertEqual(runtime.current_turn.state.value, "open_speaking")
        self.assertEqual([part.speech_state for part in runtime.current_turn.parts], ["speaking"])

        await tts_task
        self.assertIsNotNone(runtime._current_lane().pending_tts)
        event_types = [event["type"] for event in websocket.sent]
        self.assertIn("tts_stream_started", event_types)
        self.assertIn("tts_stream_chunk", event_types)
        self.assertIn("tts_stream_complete", event_types)
        self.assertLess(event_types.index("tts_stream_started"), event_types.index("tts_stream_chunk"))
        self.assertLess(event_types.index("tts_stream_chunk"), event_types.index("tts_stream_complete"))

        await runtime.tts_delivery.playback_complete(
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

    async def test_replay_reuses_the_turn_artifact_without_new_synthesis(self) -> None:
        tts = FastTTS()
        runtime, websocket = self.make_runtime(tts)

        await runtime._speak_now()
        await runtime._current_lane().tts_task
        await runtime.tts_delivery.playback_complete(
            {
                "lane_id": "a_to_b",
                "turn_id": runtime.current_turn.turn_id,
                "artifact_id": "artifact_1",
            }
        )
        await runtime.tts_delivery.replay(
            {"lane_id": "a_to_b", "part_id": "turn_1_part_1"}
        )

        self.assertEqual(tts.fairness_keys, ["principal_test"])
        self.assertEqual(tts.count, 1)
        replay = next(item for item in websocket.sent if item["type"] == "tts_artifact_ready")
        self.assertEqual(replay["part_id"], "turn_1_part_1")
        self.assertEqual(replay["text"], "Test")
        self.assertEqual(replay["playback_kind"], "replay")
        self.assertEqual(replay["playback_trigger"], "explicit")
        self.assertEqual(replay["tts"]["artifact_id"], "artifact_1")

    async def test_unavailable_replay_returns_the_bubble_to_pending(self) -> None:
        runtime, websocket = self.make_runtime(FastTTS())

        await runtime._speak_now()
        await runtime._current_lane().tts_task
        await runtime.tts_delivery.playback_complete(
            {
                "lane_id": "a_to_b",
                "turn_id": runtime.current_turn.turn_id,
                "artifact_id": "artifact_1",
            }
        )
        runtime.tts_delivery.preparations.clear()

        await runtime.tts_delivery.replay(
            {"lane_id": "a_to_b", "part_id": "turn_1_part_1"}
        )

        self.assertEqual(runtime.current_turn.parts[0].speech_state, "pending")
        self.assertEqual(runtime.current_turn.state.value, "open_active_unspoken")
        self.assertTrue(
            any(
                item["type"] == "turn_update"
                and item["reason"] == "tts_replay_unavailable"
                for item in websocket.sent
            )
        )

    async def test_stop_cancels_an_active_stream_and_returns_the_part_to_pending(self) -> None:
        runtime, websocket = self.make_runtime(SlowTTS())

        await runtime._speak_now()
        await asyncio.sleep(0.02)
        await runtime.tts_delivery.stop(
            {
                "lane_id": "a_to_b",
                "turn_id": runtime.current_turn.turn_id,
                "artifact_id": "late_artifact",
            }
        )
        await asyncio.sleep(0.25)

        self.assertEqual(runtime.current_turn.parts[0].speech_state, "pending")
        self.assertEqual(runtime.current_turn.state.value, "open_active_unspoken")
        self.assertIsNone(runtime._current_lane().tts_task)
        self.assertTrue(
            any(
                item["type"] == "tts_stream_failed"
                and item["artifact_id"] == "late_artifact"
                for item in websocket.sent
            )
        )
        self.assertFalse(any(item["type"] == "tts_stream_complete" for item in websocket.sent))

    async def test_stop_cancels_pool_work_before_the_first_stream_event(self) -> None:
        tts = BlockingTTS()
        runtime, _websocket = self.make_runtime(tts)

        await runtime._speak_now()
        self.assertTrue(await asyncio.to_thread(tts.started.wait, 1.0))
        await runtime.tts_delivery.stop(
            {
                "lane_id": "a_to_b",
                "turn_id": runtime.current_turn.turn_id,
                "artifact_id": "",
            }
        )

        self.assertTrue(await asyncio.to_thread(tts.cancelled.wait, 1.0))
        self.assertEqual(runtime.current_turn.parts[0].speech_state, "pending")
        self.assertIsNone(runtime._current_lane().tts_task)

    async def test_stop_settles_only_the_current_completed_bubble(self) -> None:
        tts = FastTTS()
        runtime, _websocket = self.make_runtime(tts)
        runtime.current_turn.parts.append(
            TurnPart(
                part_id="turn_1_part_2",
                source_committed_text="Nog een",
                target_committed_text="Another",
            )
        )
        runtime._refresh_turn_state()

        await runtime._speak_now()
        await runtime._current_lane().tts_task
        await runtime.tts_delivery.stop(
            {
                "lane_id": "a_to_b",
                "turn_id": runtime.current_turn.turn_id,
                "artifact_id": "artifact_1",
            }
        )

        self.assertEqual(
            [part.speech_state for part in runtime.current_turn.parts],
            ["spoken", "pending"],
        )
        self.assertEqual(
            runtime.tts_delivery.preparations[(runtime.current_turn.turn_id, "turn_1_part_1")].state,
            "ready",
        )
        self.assertEqual(
            runtime.tts_delivery.preparations[(runtime.current_turn.turn_id, "turn_1_part_2")].state,
            "ready",
        )
        self.assertFalse(runtime._current_lane().pending_tts)

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

    async def test_tts_settings_update_applies_to_current_session_only(self) -> None:
        tts = FastTTS()
        runtime, websocket = self.make_runtime(tts)

        with patch("app.runtime.SESSIONS.update", return_value={}) as update_session:
            await runtime._update_tts_settings({"settings": {"enabled": True, "backend": "kokoro"}})

        update_session.assert_called_once()
        self.assertEqual(runtime.tts_settings["backend"], "kokoro")
        self.assertTrue(any(event["type"] == "tts_settings" for event in websocket.sent))

        await runtime._speak_now()
        await runtime._current_lane().tts_task

        self.assertEqual(tts.settings[-1]["backend"], "kokoro")
        self.assertTrue(tts.settings[-1]["enabled"])

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
            tts_fairness_key="principal_test",
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
            await runtime.lifecycle.close()
            self.runtimes = [item for item in getattr(self, "runtimes", []) if item is not runtime]
            path.unlink(missing_ok=True)

    async def test_next_turn_while_tts_is_pending_closes_turn_and_drops_late_audio(self) -> None:
        runtime, websocket = self.make_runtime(SlowTTS())

        await runtime._speak_now()
        old_turn_id = runtime.current_turn.turn_id
        self.assertEqual(runtime.current_turn.state.value, "open_speaking")

        await runtime._next_turn(lane_id="b_to_a")
        await asyncio.sleep(0.3)
        await runtime.tts_delivery.playback_complete(
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
        self.assertFalse(runtime.lanes["a_to_b"].pending_tts)
        self.assertFalse(runtime.tts_delivery.active_stream_artifacts)
        self.assertFalse(any(event["type"] == "tts_stream_complete" for event in websocket.sent))

    async def test_next_turn_before_stream_start_does_not_leak_active_artifact(self) -> None:
        tts = LateStartTTS()
        runtime, websocket = self.make_runtime(tts)

        await runtime._speak_now()
        self.assertTrue(await asyncio.to_thread(tts.entered.wait, 1.0))
        await runtime._next_turn(lane_id="b_to_a")
        tts.release.set()
        await asyncio.sleep(0.05)

        self.assertFalse(runtime.tts_delivery.active_stream_artifacts)
        self.assertFalse(any(event["type"] == "tts_stream_started" for event in websocket.sent))

    async def test_closing_a_turn_discards_its_tts_preparations(self) -> None:
        runtime, _websocket = self.make_runtime(FastTTS())

        await runtime._speak_now()
        await runtime._current_lane().tts_task
        await runtime.tts_delivery.playback_complete(
            {
                "lane_id": "a_to_b",
                "turn_id": runtime.current_turn.turn_id,
                "artifact_id": "artifact_1",
            }
        )
        self.assertTrue(runtime.tts_delivery.preparations)

        await runtime._next_turn(lane_id="b_to_a")

        self.assertFalse(runtime.tts_delivery.preparations)

    async def test_finish_closes_without_forced_asr_or_translation_drain(self) -> None:
        runtime, websocket = self.make_runtime(FastTTS())
        lane = runtime._current_lane()
        lane.translation_task = asyncio.create_task(asyncio.sleep(60))
        runtime.lifecycle.listening = True

        with (
            patch("app.voice.session_lifecycle.SESSIONS.update", return_value={}),
            patch.object(runtime, "_poll_asr_all", new_callable=AsyncMock) as poll_asr,
            patch.object(runtime, "_enqueue_asr", new_callable=AsyncMock) as enqueue_asr,
            patch.object(runtime, "_commit_preview_tail", new_callable=AsyncMock) as commit_tail,
        ):
            await runtime.lifecycle.pause_listening()

        poll_asr.assert_not_awaited()
        enqueue_asr.assert_not_awaited()
        commit_tail.assert_not_awaited()
        self.assertFalse(runtime.lifecycle.listening)
        self.assertIsNone(lane.translation_task)
        self.assertTrue(any(event["type"] == "ended" for event in websocket.sent))
        self.assertIsNotNone(websocket.closed_code)


if __name__ == "__main__":
    unittest.main()
