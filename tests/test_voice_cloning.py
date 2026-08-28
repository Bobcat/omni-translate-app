from __future__ import annotations

import shutil
import tempfile
import time
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from app.tts_bridge import _tts_pool_request_payload
from app.tts_bridge import product_voice_cloning_settings
from app.tts_bridge import tts_settings_payload
from app.tts_bridge import tts_settings_snapshot
from app.runtime import ConversationRuntime
from app.runtime import TurnPart
from app.sessions import ConversationSession
from app.voice import cloning
from app.voice.cloning import normalize_voice_cloning_settings
from app.voice.cloning import VoiceCloningReference
from app.voice.cloning import VoiceCloningWindow
from app.voice.session_storage import release_session_artifact_tracking
from app.voice.session_storage import SessionArtifactLimitExceeded
from app.voice.tts_delivery import TtsDelivery


class VoiceCloningWindowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="voice-cloning-test-"))
        self.session_id = "conv_voice_cloning_test"
        self.reference_root_patcher = mock.patch.object(cloning, "REFERENCE_ROOT", self.root / "tts")
        self.reference_root_patcher.start()
        self.addCleanup(self.reference_root_patcher.stop)
        self.addCleanup(release_session_artifact_tracking, self.session_id)
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))

    def window(self, *, min_ms: int = 3000, max_ms: int = 10000) -> VoiceCloningWindow:
        window = VoiceCloningWindow(session_id=self.session_id, lane_ids=("a_to_b", "b_to_a"))
        window.min_duration_ms = min_ms
        window.max_duration_ms = max_ms
        window.set_enabled(True)
        return window

    def wav(self, name: str, *, duration_ms: int, sample: int = 100) -> Path:
        path = self.root / f"{name}.wav"
        path.parent.mkdir(parents=True, exist_ok=True)
        frames = int(duration_ms * 16_000 / 1000)
        value = int(sample).to_bytes(2, "little", signed=True)
        with wave.open(str(path), "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(16_000)
            writer.writeframes(value * frames)
        return path

    def test_combines_complete_segments_across_asr_results(self) -> None:
        window = self.window()
        first = self.wav("first", duration_ms=2000, sample=100)
        second = self.wav("second", duration_ms=2000, sample=200)

        changed = window.record_asr_result(
            lane_id="a_to_b",
            request_id="asr_1",
            wav_path=str(first),
            wav_t0_ms=0,
            wav_t1_ms=2000,
            segments=[{"segment_id": "s1", "t0_ms": 0, "t1_ms": 2000, "text": "First words"}],
        )
        self.assertFalse(changed)
        self.assertEqual(window.state("a_to_b"), "preparing")

        changed = window.record_asr_result(
            lane_id="a_to_b",
            request_id="asr_2",
            wav_path=str(second),
            wav_t0_ms=2000,
            wav_t1_ms=4000,
            segments=[{"segment_id": "s2", "t0_ms": 2000, "t1_ms": 3500, "text": "Second words"}],
        )

        self.assertTrue(changed)
        reference = window.reference("a_to_b")
        self.assertIsNotNone(reference)
        self.assertEqual(reference.prompt_text, "First words Second words")
        self.assertEqual(reference.duration_ms, 3500)
        self.assertEqual(reference.segment_count, 2)
        self.assertEqual(reference.source_request_ids, ("asr_1", "asr_2"))
        with wave.open(reference.wav_path, "rb") as reader:
            self.assertEqual(reader.getnframes(), 56_000)

    def test_newest_overlapping_asr_segments_win_without_duplicate_audio(self) -> None:
        window = self.window()
        old = self.wav("old", duration_ms=3000, sample=100)
        new = self.wav("new", duration_ms=3000, sample=200)
        segments = [
            {"segment_id": f"s{index}", "t0_ms": index * 1000, "t1_ms": (index + 1) * 1000, "text": f"old {index}"}
            for index in range(3)
        ]
        window.record_asr_result(
            lane_id="a_to_b",
            request_id="asr_old",
            wav_path=str(old),
            wav_t0_ms=0,
            wav_t1_ms=3000,
            segments=segments,
        )

        window.record_asr_result(
            lane_id="a_to_b",
            request_id="asr_new",
            wav_path=str(new),
            wav_t0_ms=0,
            wav_t1_ms=3000,
            segments=[{**segment, "text": segment["text"].replace("old", "new")} for segment in segments],
        )

        reference = window.reference("a_to_b")
        self.assertEqual(reference.prompt_text, "new 0 new 1 new 2")
        self.assertEqual(reference.duration_ms, 3000)
        self.assertEqual(reference.source_request_ids, ("asr_new",))

    def test_segment_larger_than_maximum_is_not_cut(self) -> None:
        window = self.window(min_ms=2000, max_ms=3000)
        source = self.wav("long", duration_ms=5000)

        changed = window.record_asr_result(
            lane_id="a_to_b",
            request_id="asr_long",
            wav_path=str(source),
            wav_t0_ms=0,
            wav_t1_ms=5000,
            segments=[{"segment_id": "long", "t0_ms": 0, "t1_ms": 5000, "text": "Too long"}],
        )

        self.assertFalse(changed)
        self.assertIsNone(window.reference("a_to_b"))

    def test_configured_minimum_is_the_only_duration_gate(self) -> None:
        window = self.window(min_ms=1000, max_ms=3000)
        source = self.wav("short-configured-reference", duration_ms=1000)

        changed = window.record_asr_result(
            lane_id="a_to_b",
            request_id="asr_short_configured",
            wav_path=str(source),
            wav_t0_ms=0,
            wav_t1_ms=1000,
            segments=[{"segment_id": "s1", "t0_ms": 0, "t1_ms": 1000, "text": "Short"}],
        )

        self.assertTrue(changed)
        self.assertEqual(window.reference("a_to_b").duration_ms, 1000)

    def test_lanes_have_independent_readiness(self) -> None:
        window = self.window()
        source = self.wav("lane-a", duration_ms=3000)
        window.record_asr_result(
            lane_id="a_to_b",
            request_id="asr_lane_a",
            wav_path=str(source),
            wav_t0_ms=0,
            wav_t1_ms=3000,
            segments=[{"segment_id": "s1", "t0_ms": 0, "t1_ms": 3000, "text": "Lane A"}],
        )

        self.assertEqual(window.state("a_to_b"), "ready")
        self.assertEqual(window.state("b_to_a"), "preparing")

    def test_reference_materialization_uses_session_storage_limit(self) -> None:
        window = self.window()
        source = self.wav("storage", duration_ms=3000)
        with mock.patch("app.voice.session_storage.session_artifact_limit_bytes", return_value=100):
            with self.assertRaises(SessionArtifactLimitExceeded):
                window.record_asr_result(
                    lane_id="a_to_b",
                    request_id="asr_storage",
                    wav_path=str(source),
                    wav_t0_ms=0,
                    wav_t1_ms=3000,
                    segments=[{"segment_id": "s1", "t0_ms": 0, "t1_ms": 3000, "text": "Storage"}],
                )


class VoiceCloningSettingsTests(unittest.TestCase):
    def test_semantic_setting_rejects_an_incompatible_backend(self) -> None:
        settings, errors = normalize_voice_cloning_settings(
            {"enabled": True},
            supported=False,
        )
        self.assertTrue(settings["enabled"])
        self.assertIn("enabled", errors)

    def test_product_mapping_sends_combined_prompt_and_reference(self) -> None:
        base, errors = tts_settings_snapshot({"enabled": True, "backend": "voxcpm2"})
        self.assertEqual(errors, {})
        settings = product_voice_cloning_settings(
            base,
            language="English",
            max_duration_s=10,
        )
        root = Path(tempfile.mkdtemp(prefix="voice-cloning-payload-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        wav_path = root / "reference.wav"
        with wave.open(str(wav_path), "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(16_000)
            writer.writeframes(b"\x00\x00" * 48_000)

        payload, _, metadata = _tts_pool_request_payload(
            text="Translated words",
            language="English",
            settings=settings,
            reference_wav_path=str(wav_path),
            reference_prompt_text="Exact source words",
        )

        reference_audio = payload["voice"]["reference_audio"]
        self.assertEqual(reference_audio["prompt_text"], "Exact source words")
        self.assertTrue(reference_audio["also_use_as_reference"])
        self.assertEqual(metadata["reference_client_source"], "last_speech")

    def test_config_capability_requires_the_configured_backend_to_be_loaded(self) -> None:
        configured, _ = tts_settings_snapshot({"enabled": True, "backend": "kokoro"})
        with (
            mock.patch("app.tts_bridge._base_tts_settings", return_value=configured),
            mock.patch("app.tts_bridge._tts_pool_loaded_models", return_value={"voxcpm2"}),
        ):
            payload = tts_settings_payload()

        self.assertEqual(payload["backend"], "voxcpm2")
        self.assertFalse(payload["capabilities"]["voice_cloning"])


class VoiceCloningDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_preparation_is_keyed_to_and_uses_the_selected_reference(self) -> None:
        settings, errors = tts_settings_snapshot({"enabled": True, "backend": "voxcpm2"})
        self.assertEqual(errors, {})
        reference = VoiceCloningReference(
            reference_id="clone_a_to_b_test",
            wav_path="/tmp/reference.wav",
            prompt_text="Exact source words",
            duration_ms=3200,
            segment_count=2,
            source_request_ids=("asr_1", "asr_2"),
            created_mono=1.0,
        )
        voice_cloning = SimpleNamespace(
            enabled=True,
            max_duration_ms=10_000,
            reference=lambda lane_id: reference if lane_id == "a_to_b" else None,
        )
        part = SimpleNamespace(part_id="part_1", target="Translated words")
        lane = SimpleNamespace(target_language="English")
        runtime = SimpleNamespace(
            session_id="conv_delivery_test",
            tts_settings=settings,
            voice_cloning=voice_cloning,
            lanes={"a_to_b": lane},
            current_turn=SimpleNamespace(turn_id="turn_1", parts=[part]),
        )
        delivery = TtsDelivery(runtime, part_target_text=lambda item: item.target)

        preparation = delivery._new_preparation(
            lane_id="a_to_b",
            turn_id="turn_1",
            part_id="part_1",
            reason="demand",
        )

        self.assertEqual(preparation.reference_id, reference.reference_id)
        self.assertEqual(preparation.reference_wav_path, reference.wav_path)
        self.assertEqual(preparation.reference_prompt_text, reference.prompt_text)
        self.assertIn(reference.reference_id, preparation.settings_key)
        language_settings = preparation.settings["voxcpm2"]["languages"]["en"]
        self.assertEqual(language_settings["reference_source"], "last_speech")
        self.assertTrue(
            preparation.settings["voxcpm2"]["ultimate_cloning"]["last_speech"]["enabled"]
        )

    async def test_preparation_is_skipped_without_a_ready_reference(self) -> None:
        settings, _ = tts_settings_snapshot({"enabled": True, "backend": "voxcpm2"})
        part = SimpleNamespace(part_id="part_1", target="Translated words")
        runtime = SimpleNamespace(
            session_id="conv_delivery_preparing_test",
            tts_settings=settings,
            voice_cloning=SimpleNamespace(
                enabled=True,
                max_duration_ms=10_000,
                reference=lambda _lane_id: None,
            ),
            lanes={"a_to_b": SimpleNamespace(target_language="English")},
            current_turn=SimpleNamespace(turn_id="turn_1", parts=[part]),
        )
        delivery = TtsDelivery(runtime, part_target_text=lambda item: item.target)

        preparation = delivery._new_preparation(
            lane_id="a_to_b",
            turn_id="turn_1",
            part_id="part_1",
            reason="speculative",
        )

        self.assertIsNone(preparation)


class VoiceCloningRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_manual_speak_while_preparing_returns_a_non_error_status(self) -> None:
        class WebSocket:
            def __init__(self) -> None:
                self.sent = []

            async def send_json(self, payload) -> None:
                self.sent.append(payload)

            async def close(self, *, code: int, reason: str = "") -> None:
                return None

        settings, _ = tts_settings_snapshot({"enabled": True, "backend": "voxcpm2"})
        session = ConversationSession(
            session_id=f"conv_voice_cloning_runtime_{time.time_ns()}",
            created_unix=time.time(),
            expires_unix=time.time() + 60,
            side_a_language="Dutch",
            side_b_language="English",
            tts_fairness_key="principal_test",
            tts_settings=settings,
            voice_cloning={"enabled": True},
        )
        websocket = WebSocket()
        runtime = ConversationRuntime(websocket=websocket, session=session)
        runtime.current_turn.parts.append(
            TurnPart(
                part_id="part_1",
                source_committed_text="Brontekst",
                target_committed_text="Translated words",
                is_closed=True,
            )
        )
        runtime._refresh_turn_state()
        self.addAsyncCleanup(runtime.lifecycle.close)

        await runtime._dispatch_speak_sequence(["part_1"], reason="speak_part")

        status = websocket.sent[-1]
        self.assertEqual(status["type"], "tts_status")
        self.assertEqual(status["state"], "skipped")
        self.assertEqual(status["reason"], "voice_clone_preparing")
        self.assertEqual(runtime.current_turn.parts[0].speech_state, "pending")


if __name__ == "__main__":
    unittest.main()
