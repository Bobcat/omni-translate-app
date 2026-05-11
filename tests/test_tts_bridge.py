from __future__ import annotations

import base64
import io
import shutil
import unittest
import wave
from unittest import mock

from app.tts_bridge import TTSBridge
from app.tts_bridge import TTS_ROOT
from app.tts_bridge import clear_tts_runtime_overrides
from app.tts_bridge import tts_settings_payload
from app.tts_bridge import tts_uses_asr_reference_wav
from app.tts_bridge import update_tts_settings


class FakeTtsPool:
    def __init__(self) -> None:
        self.calls = []

    def post_json(self, url, payload, *, timeout_s):
        self.calls.append(
            {
                "url": url,
                "payload": payload,
                "timeout_s": timeout_s,
            }
        )
        return {
            "id": "ttsresp_test",
            "object": "tts_response",
            "model": payload["model"],
            "audio": {
                "mime_type": "audio/wav",
                "data_base64": base64.b64encode(b"wav-bytes").decode("ascii"),
                "sample_rate_hz": 24000,
                "duration_ms": 100,
            },
            "metrics": {
                "engine_queue_wait_ms": 1.0,
                "backend_synthesis_wall_ms": 2.0,
                "pool_total_wall_ms": 3.0,
            },
            "metadata": {
                "engine": payload["model"],
                "voice": payload.get("voice", {}).get("preset", ""),
                "device": "remote",
                "model_id": payload["model"],
            },
        }


class TTSBridgeTests(unittest.TestCase):
    def tearDown(self) -> None:
        clear_tts_runtime_overrides()

    def test_synthesize_sends_kokoro_request_to_tts_pool_and_writes_artifact(self) -> None:
        update_tts_settings(
            {
                "backend": "kokoro",
                "kokoro": {"voices": {"English": "af_sarah"}},
            }
        )
        fake_pool = FakeTtsPool()
        session_id = "conv_test_tts_pool_kokoro"
        self.addCleanup(lambda: shutil.rmtree(TTS_ROOT / session_id, ignore_errors=True))

        with mock.patch("app.tts_bridge._post_json", side_effect=fake_pool.post_json):
            payload = TTSBridge().synthesize(session_id=session_id, text="Hello", language="English")

        request = fake_pool.calls[0]["payload"]
        self.assertEqual(request["model"], "kokoro")
        self.assertEqual(request["input"], "Hello")
        self.assertEqual(request["language"], "English")
        self.assertEqual(request["voice"]["preset"], "af_sarah")
        self.assertNotIn("reference_audio", request["voice"])

        artifact = TTS_ROOT / session_id / f"{payload['artifact_id']}.wav"
        self.assertEqual(artifact.read_bytes(), b"wav-bytes")
        self.assertEqual(payload["mime_type"], "audio/wav")
        self.assertEqual(payload["sample_rate_hz"], 24000)
        self.assertEqual(payload["duration_ms"], 100)
        self.assertEqual(payload["metadata"]["tts_pool_response_id"], "ttsresp_test")
        self.assertEqual(payload["metadata"]["tts_pool_model"], "kokoro")
        self.assertIn("tts_pool_request_wall_ms", payload["metrics"])
        self.assertIn("tts_artifact_write_ms", payload["metrics"])
        self.assertIn("tts_total_wall_ms", payload["metrics"])

    def test_synthesize_sends_voxcpm2_reference_audio_to_tts_pool(self) -> None:
        update_tts_settings(
            {
                "backend": "voxcpm2",
                "voxcpm2": {
                    "voice_presets": {"Dutch": "configured"},
                    "use_input_audio_reference": True,
                    "reference_max_duration_s": 2,
                },
            }
        )
        fake_pool = FakeTtsPool()
        session_id = "conv_test_tts_pool_voxcpm2"
        session_root = TTS_ROOT / session_id
        source_path = session_root / "source.wav"
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_bytes(_silent_wav(seconds=3.0))
        self.addCleanup(lambda: shutil.rmtree(session_root, ignore_errors=True))

        with mock.patch("app.tts_bridge._post_json", side_effect=fake_pool.post_json):
            payload = TTSBridge().synthesize(
                session_id=session_id,
                text="Hallo",
                language="Dutch",
                reference_wav_path=str(source_path),
            )

        request = fake_pool.calls[0]["payload"]
        self.assertEqual(request["model"], "voxcpm2")
        self.assertNotIn("preset", request["voice"])
        self.assertIn("Speak in Dutch", request["voice"]["instructions"])
        self.assertNotIn("Match the speaking pace", request["voice"]["instructions"])
        reference_audio = request["voice"]["reference_audio"]
        self.assertEqual(reference_audio["mime_type"], "audio/wav")
        self.assertEqual(reference_audio["max_duration_s"], 2.0)
        self.assertNotIn("reference_audio_match", request["voice"])
        reference_bytes = base64.b64decode(reference_audio["data_base64"])
        self.assertLess(len(reference_bytes), source_path.stat().st_size)
        self.assertLessEqual(_wav_duration_ms(reference_bytes), 2000)
        self.assertTrue(payload["metadata"]["reference_client_clipped"])
        self.assertEqual(payload["metadata"]["reference_client_source_duration_ms"], 3000)
        self.assertLessEqual(payload["metadata"]["reference_client_duration_ms"], 2000)
        self.assertIn("tts_reference_prepare_wall_ms", payload["metrics"])
        self.assertIn("tts_reference_payload_bytes", payload["metrics"])

    def test_voxcpm2_reference_audio_is_omitted_when_disabled(self) -> None:
        update_tts_settings(
            {
                "backend": "voxcpm2",
                "voxcpm2": {
                    "use_input_audio_reference": False,
                    "voice_presets": {"Dutch": "warm_female"},
                },
            }
        )
        fake_pool = FakeTtsPool()
        session_id = "conv_test_tts_pool_no_reference"
        self.addCleanup(lambda: shutil.rmtree(TTS_ROOT / session_id, ignore_errors=True))

        with mock.patch("app.tts_bridge._post_json", side_effect=fake_pool.post_json):
            TTSBridge().synthesize(
                session_id=session_id,
                text="Hallo",
                language="Dutch",
                reference_wav_path="/tmp/source.wav",
            )

        request = fake_pool.calls[0]["payload"]
        self.assertNotIn("preset", request["voice"])
        self.assertIn("Speak in Dutch", request["voice"]["instructions"])
        self.assertIn("Use a warm adult female voice", request["voice"]["instructions"])
        self.assertNotIn("reference_audio", request["voice"])
        self.assertFalse(tts_uses_asr_reference_wav())

    def test_synthesize_sends_nanovllm_voxcpm_request_to_tts_pool(self) -> None:
        update_tts_settings(
            {
                "backend": "nanovllm_voxcpm",
                "voxcpm2": {
                    "voice_presets": {"Dutch": "configured"},
                    "use_input_audio_reference": True,
                    "reference_max_duration_s": 2,
                    "reference_match": "voice_and_pace",
                },
            }
        )
        fake_pool = FakeTtsPool()
        session_id = "conv_test_tts_pool_nanovllm_voxcpm"
        session_root = TTS_ROOT / session_id
        source_path = session_root / "source.wav"
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_bytes(_silent_wav(seconds=3.0))
        self.addCleanup(lambda: shutil.rmtree(session_root, ignore_errors=True))

        with mock.patch("app.tts_bridge._post_json", side_effect=fake_pool.post_json):
            TTSBridge().synthesize(
                session_id=session_id,
                text="Hallo",
                language="Dutch",
                reference_wav_path=str(source_path),
            )

        request = fake_pool.calls[0]["payload"]
        self.assertEqual(request["model"], "nanovllm_voxcpm")
        self.assertNotIn("preset", request["voice"])
        self.assertIn("Speak in Dutch", request["voice"]["instructions"])
        self.assertIn("Match the speaking pace", request["voice"]["instructions"])
        self.assertIn("reference_audio", request["voice"])
        self.assertTrue(tts_uses_asr_reference_wav())

    def test_update_tts_settings_applies_user_facing_delta(self) -> None:
        settings, errors = update_tts_settings(
            {
                "backend": "voxcpm2",
                "voxcpm2": {
                    "voice_presets": {"Dutch": "warm_female"},
                    "use_input_audio_reference": True,
                    "reference_max_duration_s": 3,
                    "reference_match": "voice_and_pace",
                },
            }
        )

        self.assertEqual(errors, {})
        self.assertEqual(settings["backend"], "voxcpm2")
        self.assertEqual(settings["voxcpm2"]["voice_presets"]["Dutch"], "warm_female")
        self.assertEqual(settings["voxcpm2"]["reference_max_duration_s"], 3.0)
        self.assertEqual(settings["voxcpm2"]["reference_match"], "voice_and_pace")
        self.assertTrue(tts_uses_asr_reference_wav())

    def test_update_tts_settings_rejects_unknown_backend(self) -> None:
        _, errors = update_tts_settings({"backend": "stub-tts"})

        self.assertIn("backend", errors)

    def test_settings_payload_exposes_user_facing_options(self) -> None:
        payload = tts_settings_payload()

        self.assertEqual(
            [backend["value"] for backend in payload["options"]["backends"]],
            ["kokoro", "voxcpm2", "nanovllm_voxcpm"],
        )
        self.assertIn("English", payload["options"]["kokoro_voices"])
        self.assertIn("voxcpm2_voice_presets", payload["options"])
        self.assertIn("{target_lang}", payload["options"]["voxcpm2_language_prompt_template"])
        self.assertIn("speaking pace", payload["options"]["voxcpm2_reference_prompt"])
        self.assertIn("voxcpm2_reference_match_options", payload["options"])

    def test_synthesize_rejects_empty_text(self) -> None:
        with self.assertRaisesRegex(ValueError, "tts_text_empty"):
            TTSBridge().synthesize(session_id="conv_test_empty", text=" ", language="English")


def _silent_wav(*, seconds: float, sample_rate_hz: int = 16000) -> bytes:
    buffer = io.BytesIO()
    frames = b"\x00\x00" * int(seconds * sample_rate_hz)
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate_hz)
        writer.writeframes(frames)
    return buffer.getvalue()


def _wav_duration_ms(data: bytes) -> int:
    with wave.open(io.BytesIO(data), "rb") as reader:
        return int((reader.getnframes() / reader.getframerate()) * 1000)


if __name__ == "__main__":
    unittest.main()
