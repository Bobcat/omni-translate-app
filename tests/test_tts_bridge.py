from __future__ import annotations

import io
import shutil
import threading
import time
import unittest
import wave
from unittest import mock

from realtime_tts_engine import TTSRequest
from realtime_tts_engine import TTSResult

from app.tts_bridge import TTSBridge
from app.tts_bridge import TTS_ROOT
from app.tts_bridge import VoxCPM2Synthesizer
from app.tts_bridge import _startup_warmup_enabled
from app.tts_bridge import _tts_backend
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
    def test_bridge_uses_configured_backend(self) -> None:
        with (
            mock.patch("app.tts_bridge.get_str", return_value="voxcpm2"),
            mock.patch("app.tts_bridge._build_synthesizer", return_value=object()) as build_synthesizer,
        ):
            bridge = TTSBridge()

        self.assertEqual(bridge.backend, "voxcpm2")
        build_synthesizer.assert_called_once_with("voxcpm2")

    def test_backend_rejects_unknown_value(self) -> None:
        with mock.patch("app.tts_bridge.get_str", return_value="bad"):
            with self.assertRaisesRegex(ValueError, "unsupported tts.backend"):
                _tts_backend()

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

    def test_warmup_runs_voxcpm2_by_default(self) -> None:
        class FakeSynthesizer:
            def supports_language(self, language: str) -> bool:
                return True

        def fake_get_bool(key: str, default: bool = False) -> bool:
            if key == "tts.enabled":
                return True
            return default

        with mock.patch("app.tts_bridge.get_bool", side_effect=fake_get_bool):
            bridge = object.__new__(TTSBridge)
            bridge.backend = "voxcpm2"
            bridge.synthesizer = FakeSynthesizer()
            bridge.engine = FakeEngine()
            bridge._synthesis_lock = threading.Lock()

            bridge.warmup()

        self.assertEqual([request.language for request in bridge.engine.requests], ["English", "Dutch"])

    def test_warmup_skips_voxcpm2_when_disabled(self) -> None:
        class FakeSynthesizer:
            def supports_language(self, language: str) -> bool:
                return True

        def fake_get_bool(key: str, default: bool = False) -> bool:
            if key == "tts.enabled":
                return True
            if key == "tts.voxcpm2_startup_warmup":
                return False
            return default

        with mock.patch("app.tts_bridge.get_bool", side_effect=fake_get_bool):
            bridge = object.__new__(TTSBridge)
            bridge.backend = "voxcpm2"
            bridge.synthesizer = FakeSynthesizer()
            bridge.engine = FakeEngine()
            bridge._synthesis_lock = threading.Lock()

            bridge.warmup()

        self.assertEqual(bridge.engine.requests, [])

    def test_voxcpm2_startup_warmup_can_be_enabled(self) -> None:
        def fake_get_bool(key: str, default: bool = False) -> bool:
            return key in {"tts.enabled", "tts.voxcpm2_startup_warmup"} or default

        with mock.patch("app.tts_bridge.get_bool", side_effect=fake_get_bool):
            self.assertTrue(_startup_warmup_enabled("voxcpm2"))

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


class VoxCPM2SynthesizerTests(unittest.TestCase):
    class FakeTTSModel:
        sample_rate = 16_000
        device = "cuda"

    class FakeModel:
        def __init__(self) -> None:
            self.tts_model = VoxCPM2SynthesizerTests.FakeTTSModel()
            self.generate_kwargs = None

        def generate(self, **kwargs):
            self.generate_kwargs = dict(kwargs)
            return [0.0, 0.5, -0.5, 0.0]

    def test_synthesize_calls_model_and_returns_wav_result(self) -> None:
        model = self.FakeModel()
        synthesizer = VoxCPM2Synthesizer(
            model_id="test-model",
            load_denoiser=False,
            optimize=True,
            cfg_value=2.0,
            inference_timesteps=8,
            normalize=False,
            denoise=False,
            control="",
            reference_wav_path="",
        )
        synthesizer._model = model

        result = synthesizer.synthesize(TTSRequest(text="Hallo wereld", language="Dutch"))

        self.assertEqual(model.generate_kwargs["text"], "Hallo wereld")
        self.assertEqual(model.generate_kwargs["cfg_value"], 2.0)
        self.assertEqual(model.generate_kwargs["inference_timesteps"], 8)
        self.assertEqual(model.generate_kwargs["normalize"], False)
        self.assertEqual(model.generate_kwargs["denoise"], False)
        self.assertEqual(result.mime_type, "audio/wav")
        self.assertEqual(result.sample_rate_hz, 16_000)
        self.assertEqual(result.metadata["engine"], "voxcpm2")
        self.assertEqual(result.metadata["model_id"], "test-model")
        self.assertEqual(result.metadata["device"], "cuda")
        with wave.open(io.BytesIO(result.audio), "rb") as reader:
            self.assertEqual(reader.getframerate(), 16_000)
            self.assertEqual(reader.getnchannels(), 1)
            self.assertEqual(reader.getsampwidth(), 2)
            self.assertEqual(reader.getnframes(), 4)

    def test_synthesize_uses_control_and_reference_audio(self) -> None:
        model = self.FakeModel()
        synthesizer = VoxCPM2Synthesizer(
            model_id="test-model",
            load_denoiser=False,
            optimize=False,
            cfg_value=2.0,
            inference_timesteps=8,
            normalize=False,
            denoise=False,
            control="Match the reference pace.",
            reference_wav_path="/tmp/default-ref.wav",
        )
        synthesizer._model = model

        result = synthesizer.synthesize(
            TTSRequest(text="Hallo wereld", language="Dutch", voice="/tmp/asr-work.wav")
        )

        self.assertEqual(model.generate_kwargs["text"], "(Match the reference pace.)Hallo wereld")
        self.assertEqual(model.generate_kwargs["reference_wav_path"], "/tmp/asr-work.wav")
        self.assertEqual(result.metadata["control"], "Match the reference pace.")
        self.assertEqual(result.metadata["reference_wav_path"], "/tmp/asr-work.wav")

    def test_denoise_requires_loaded_denoiser(self) -> None:
        with self.assertRaisesRegex(ValueError, "voxcpm2_denoise"):
            VoxCPM2Synthesizer(
                model_id="test-model",
                load_denoiser=False,
                optimize=True,
                cfg_value=2.0,
                inference_timesteps=8,
                normalize=False,
                denoise=True,
                control="",
                reference_wav_path="",
            )

    def test_supports_dutch_language(self) -> None:
        synthesizer = VoxCPM2Synthesizer(
            model_id="test-model",
            load_denoiser=False,
            optimize=True,
            cfg_value=2.0,
            inference_timesteps=8,
            normalize=False,
            denoise=False,
            control="",
            reference_wav_path="",
        )

        self.assertTrue(synthesizer.supports_language("Dutch"))


if __name__ == "__main__":
    unittest.main()
