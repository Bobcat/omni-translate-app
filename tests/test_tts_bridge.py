from __future__ import annotations

import shutil
import threading
import time
import unittest
from unittest import mock

from realtime_tts_engine import TTSResult

from app.tts_bridge import TTSBridge
from app.tts_bridge import TTS_ROOT
from app.tts_bridge import _warmup_languages
from app.tts_bridge import _warmup_text


class FakeEngine:
    def __init__(self) -> None:
        self.requests = []

    def synthesize(self, request):
        self.requests.append(request)
        time.sleep(0.001)
        return TTSResult(
            audio=b"wav",
            mime_type="audio/wav",
            sample_rate_hz=24000,
            duration_ms=100,
            timings={
                "kokoro_total_wall_ms": 1.2,
                "kokoro_pipeline_wall_ms": 1.0,
                "kokoro_preprocess_ms": 0.1,
                "kokoro_model_inference_ms": 0.7,
                "kokoro_postprocess_ms": 0.2,
                "chunk_count": 1.0,
                "input_chars": 5.0,
                "output_audio_seconds": 0.1,
                "realtime_factor": 0.01,
            },
            metadata={
                "engine": "kokoro",
                "voice": "af_heart",
                "language_code": "a",
                "language": "English",
                "device": "cpu",
                "model_id": "hexgrad/Kokoro-82M",
            },
        )


class TTSBridgeMetricsTests(unittest.TestCase):
    def test_synthesize_returns_queue_and_kokoro_metrics(self) -> None:
        bridge = object.__new__(TTSBridge)
        bridge.engine = FakeEngine()
        bridge._synthesis_lock = threading.Lock()
        session_id = "conv_test_tts_metrics"
        self.addCleanup(lambda: shutil.rmtree(TTS_ROOT / session_id, ignore_errors=True))

        payload = bridge.synthesize(session_id=session_id, text="Hello", language="English")

        self.assertIn("metrics", payload)
        self.assertIn("metadata", payload)
        for field in (
            "queue_wait_ms",
            "tts_total_wall_ms",
            "tts_synthesis_wall_ms",
            "tts_artifact_write_ms",
            "kokoro_total_wall_ms",
            "kokoro_pipeline_wall_ms",
            "kokoro_preprocess_ms",
            "kokoro_model_inference_ms",
            "kokoro_postprocess_ms",
            "chunk_count",
            "input_chars",
            "output_audio_seconds",
            "realtime_factor",
        ):
            self.assertIn(field, payload["metrics"])
            self.assertIsInstance(payload["metrics"][field], float)

        self.assertEqual(payload["metadata"]["engine"], "kokoro")
        self.assertEqual(payload["metadata"]["voice"], "af_heart")
        self.assertEqual(payload["metadata"]["device"], "cpu")
        self.assertEqual(payload["metadata"]["model_id"], "hexgrad/Kokoro-82M")

    def test_warmup_uses_supported_configured_conversation_languages(self) -> None:
        class FakeSynthesizer:
            def supports_language(self, language: str) -> bool:
                return str(language).lower() in {"english", "chinese"}

        with (
            mock.patch("app.tts_bridge.get_bool", return_value=True),
            mock.patch(
                "app.tts_bridge.get_str",
                side_effect=lambda key, default="": {
                    "tts.warmup_language": "English",
                    "translation.source_language": "Chinese",
                    "translation.target_language": "Dutch",
                }.get(key, default),
            ),
        ):
            bridge = object.__new__(TTSBridge)
            bridge.synthesizer = FakeSynthesizer()
            bridge.engine = FakeEngine()
            bridge._synthesis_lock = threading.Lock()

            bridge.warmup()

        self.assertEqual([request.language for request in bridge.engine.requests], ["English", "Chinese"])
        self.assertEqual(bridge.engine.requests[1].text, "准备好了。")

    def test_warmup_helpers_filter_unsupported_languages(self) -> None:
        class FakeSynthesizer:
            def supports_language(self, language: str) -> bool:
                return str(language).lower() == "english"

        with mock.patch(
            "app.tts_bridge.get_str",
            side_effect=lambda key, default="": {
                "tts.warmup_language": "English",
                "translation.source_language": "Dutch",
                "translation.target_language": "English",
            }.get(key, default),
        ):
            self.assertEqual(_warmup_languages(FakeSynthesizer()), ["English"])
        self.assertEqual(_warmup_text("English"), "Ready.")


if __name__ == "__main__":
    unittest.main()
