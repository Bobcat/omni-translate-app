from __future__ import annotations

import base64
import io
import json
import shutil
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

from app.tts_bridge import TTSBridge
from app.tts_bridge import TTS_ROOT
from app.tts_bridge import tts_settings_payload
from app.tts_bridge import tts_settings_snapshot
from app.tts_bridge import tts_uses_asr_reference_wav


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
    def setUp(self) -> None:
        self.loaded_models_patcher = mock.patch(
            "app.tts_bridge._tts_pool_loaded_models",
            return_value={"kokoro", "voxcpm2", "nanovllm_voxcpm"},
        )
        self.loaded_models = self.loaded_models_patcher.start()
        self.addCleanup(self.loaded_models_patcher.stop)

    def _isolated_voice_library_root(self) -> Path:
        # Redirect STABLE_VOICE_LIBRARY_ROOT to a tmp dir so tests never
        # touch real data/voice_library/stable/ — previous version wrote
        # into nl/female/ and rmtree'd nl/ on teardown, wiping any real
        # samples the developer had generated for Dutch.
        from app import voice_library
        tmp_root = Path(tempfile.mkdtemp(prefix="test_stable_voice_lib_"))
        patcher = mock.patch.object(voice_library, "STABLE_VOICE_LIBRARY_ROOT", tmp_root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(lambda: shutil.rmtree(tmp_root, ignore_errors=True))
        return tmp_root

    def _settings(self, delta: dict | None = None) -> dict:
        settings, errors = tts_settings_snapshot(delta or {})
        self.assertEqual(errors, {})
        return settings

    def test_synthesize_sends_kokoro_request_to_tts_pool_and_writes_artifact(self) -> None:
        settings = self._settings({
            "backend": "kokoro",
            "kokoro": {"voices": {"English": "af_sarah"}},
        })
        fake_pool = FakeTtsPool()
        session_id = "conv_test_tts_pool_kokoro"
        self.addCleanup(lambda: shutil.rmtree(TTS_ROOT / session_id, ignore_errors=True))

        with mock.patch("app.tts_bridge._post_json", side_effect=fake_pool.post_json):
            payload = TTSBridge().synthesize(
                session_id=session_id,
                text="Hello",
                language="English",
                settings=settings,
            )

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
        settings = self._settings({
            "backend": "voxcpm2",
            "voxcpm2": {
                "languages": {
                    "nl": {
                        "mode": "reference_audio",
                        "reference_source": "last_speech",
                        "trim_seconds": 2,
                    },
                },
            },
        })
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
                settings=settings,
                reference_wav_path=str(source_path),
            )

        request = fake_pool.calls[0]["payload"]
        self.assertEqual(request["model"], "voxcpm2")
        self.assertNotIn("preset", request["voice"])
        # Reference-audio mode: no text instructions at all — the
        # reference WAV is the voice signal.
        self.assertNotIn("instructions", request["voice"])
        reference_audio = request["voice"]["reference_audio"]
        self.assertEqual(reference_audio["mime_type"], "audio/wav")
        self.assertEqual(reference_audio["max_duration_s"], 2.0)
        reference_bytes = base64.b64decode(reference_audio["data_base64"])
        self.assertLess(len(reference_bytes), source_path.stat().st_size)
        self.assertLessEqual(_wav_duration_ms(reference_bytes), 2000)
        self.assertTrue(payload["metadata"]["reference_client_clipped"])
        self.assertEqual(payload["metadata"]["reference_client_source_duration_ms"], 3000)
        self.assertLessEqual(payload["metadata"]["reference_client_duration_ms"], 2000)
        self.assertEqual(payload["metadata"]["reference_client_source"], "last_speech")
        self.assertIn("tts_reference_prepare_wall_ms", payload["metrics"])
        self.assertIn("tts_reference_payload_bytes", payload["metrics"])

    def test_voxcpm2_description_mode_combines_identity_and_texture(self) -> None:
        settings = self._settings({
            "backend": "voxcpm2",
            "voxcpm2": {
                "languages": {
                    "nl": {
                        "mode": "description",
                        "identity": "adult_woman",
                        "texture": "gentle_and_warm",
                    },
                },
            },
        })
        fake_pool = FakeTtsPool()
        session_id = "conv_test_tts_pool_no_reference"
        self.addCleanup(lambda: shutil.rmtree(TTS_ROOT / session_id, ignore_errors=True))

        with mock.patch("app.tts_bridge._post_json", side_effect=fake_pool.post_json):
            TTSBridge().synthesize(
                session_id=session_id,
                text="Hallo",
                language="Dutch",
                settings=settings,
                reference_wav_path="/tmp/source.wav",
            )

        request = fake_pool.calls[0]["payload"]
        self.assertNotIn("preset", request["voice"])
        self.assertEqual(
            request["voice"]["instructions"],
            "adult female voice, gentle and warm tone",
        )
        self.assertNotIn("reference_audio", request["voice"])
        self.assertFalse(tts_uses_asr_reference_wav("Dutch", settings=settings))

    def test_synthesize_sends_nanovllm_voxcpm_request_to_tts_pool(self) -> None:
        settings = self._settings({
            "backend": "nanovllm_voxcpm",
            "voxcpm2": {
                "languages": {
                    "nl": {
                        "mode": "reference_audio",
                        "reference_source": "last_speech",
                        "trim_seconds": 2,
                    },
                },
            },
        })
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
                settings=settings,
                reference_wav_path=str(source_path),
            )

        request = fake_pool.calls[0]["payload"]
        self.assertEqual(request["model"], "nanovllm_voxcpm")
        self.assertNotIn("preset", request["voice"])
        self.assertNotIn("instructions", request["voice"])
        self.assertIn("reference_audio", request["voice"])
        self.assertTrue(tts_uses_asr_reference_wav("Dutch", settings=settings))

    def test_tts_settings_snapshot_applies_user_facing_delta(self) -> None:
        settings, errors = tts_settings_snapshot({
            "backend": "voxcpm2",
            "voxcpm2": {
                "languages": {
                    "nl": {
                        "mode": "reference_audio",
                        "reference_source": "last_speech",
                        "trim_seconds": 3,
                    },
                },
            },
        })

        self.assertEqual(errors, {})
        self.assertEqual(settings["backend"], "voxcpm2")
        self.assertEqual(
            settings["voxcpm2"]["languages"]["nl"],
            {
                "mode": "reference_audio",
                "texture": "",
                "preset": "",
                "reference_source": "last_speech",
                "trim_seconds": 3.0,
                "trim_to_source": False,
            },
        )
        self.assertTrue(tts_uses_asr_reference_wav("Dutch", settings=settings))

    def test_synthesize_uses_stable_voice_sample_when_selected(self) -> None:
        tmp_root = self._isolated_voice_library_root()

        settings = self._settings({
            "backend": "voxcpm2",
            "voxcpm2": {
                "languages": {
                    "nl": {
                        "mode": "reference_audio",
                        "reference_source": "stable_generated",
                        "trim_seconds": 4,
                    },
                },
            },
        })
        stable_dir = tmp_root / "nl" / "female"
        stable_dir.mkdir(parents=True, exist_ok=True)
        stable_path = stable_dir / "audio.wav"
        stable_path.write_bytes(_silent_wav(seconds=2.5))

        fake_pool = FakeTtsPool()
        session_id = "conv_test_stable_sample"
        self.addCleanup(lambda: shutil.rmtree(TTS_ROOT / session_id, ignore_errors=True))

        # ASR wav is intentionally not provided — runtime would skip it for stable_generated.
        self.assertFalse(tts_uses_asr_reference_wav("Dutch", settings=settings))

        with mock.patch("app.tts_bridge._post_json", side_effect=fake_pool.post_json):
            payload = TTSBridge().synthesize(
                session_id=session_id,
                text="Hallo",
                language="Dutch",
                settings=settings,
                reference_wav_path=None,
            )

        request = fake_pool.calls[0]["payload"]
        self.assertEqual(request["model"], "voxcpm2")
        self.assertIn("reference_audio", request["voice"])
        self.assertNotIn("instructions", request["voice"])
        self.assertEqual(payload["metadata"]["reference_client_source"], "stable_generated")
        self.assertEqual(request["voice"]["reference_audio"]["max_duration_s"], 4.0)

    def test_stable_generated_ultimate_cloning_sends_prompt_text_from_meta(self) -> None:
        tmp_root = self._isolated_voice_library_root()

        settings = self._settings({
            "backend": "voxcpm2",
            "voxcpm2": {
                "languages": {
                    "nl": {
                        "mode": "reference_audio",
                        "reference_source": "stable_generated",
                        "trim_seconds": 1,
                    },
                },
                "ultimate_cloning": {
                    "stable_generated": {"enabled": True, "also_use_as_reference": True},
                },
            },
        })
        stable_dir = tmp_root / "nl" / "female"
        stable_dir.mkdir(parents=True, exist_ok=True)
        (stable_dir / "audio.wav").write_bytes(_silent_wav(seconds=5.0))
        (stable_dir / "meta.json").write_text(
            json.dumps({"reference_text": "Ik lees dit korte bericht met een rustige stem."}),
            encoding="utf-8",
        )

        fake_pool = FakeTtsPool()
        session_id = "conv_test_uc2_stable"
        self.addCleanup(lambda: shutil.rmtree(TTS_ROOT / session_id, ignore_errors=True))

        with mock.patch("app.tts_bridge._post_json", side_effect=fake_pool.post_json):
            payload = TTSBridge().synthesize(
                session_id=session_id,
                text="Hallo",
                language="Dutch",
                settings=settings,
                reference_wav_path=None,
            )

        reference_audio = fake_pool.calls[0]["payload"]["voice"]["reference_audio"]
        reference_bytes = base64.b64decode(reference_audio["data_base64"])
        self.assertEqual(_wav_duration_ms(reference_bytes), 5000)
        self.assertEqual(reference_audio["max_duration_s"], 5.0)
        self.assertEqual(
            reference_audio["prompt_text"],
            "Ik lees dit korte bericht met een rustige stem.",
        )
        self.assertTrue(reference_audio["also_use_as_reference"])
        self.assertFalse(payload["metadata"]["reference_client_clipped"])
        self.assertTrue(payload["metadata"]["reference_client_clip_skipped_for_prompt_text"])

    def test_stable_generated_toggle_off_stays_reference_only(self) -> None:
        tmp_root = self._isolated_voice_library_root()

        settings = self._settings({
            "backend": "voxcpm2",
            "voxcpm2": {
                "languages": {
                    "nl": {
                        "mode": "reference_audio",
                        "reference_source": "stable_generated",
                        "trim_seconds": 4,
                    },
                },
                "ultimate_cloning": {
                    "stable_generated": {"enabled": False},
                },
            },
        })
        stable_dir = tmp_root / "nl" / "female"
        stable_dir.mkdir(parents=True, exist_ok=True)
        (stable_dir / "audio.wav").write_bytes(_silent_wav(seconds=2.5))
        (stable_dir / "meta.json").write_text(
            json.dumps({"reference_text": "Curated transcript."}), encoding="utf-8"
        )

        fake_pool = FakeTtsPool()
        session_id = "conv_test_no_uc_stable"
        self.addCleanup(lambda: shutil.rmtree(TTS_ROOT / session_id, ignore_errors=True))

        with mock.patch("app.tts_bridge._post_json", side_effect=fake_pool.post_json):
            TTSBridge().synthesize(
                session_id=session_id,
                text="Hallo",
                language="Dutch",
                settings=settings,
                reference_wav_path=None,
            )

        reference_audio = fake_pool.calls[0]["payload"]["voice"]["reference_audio"]
        self.assertNotIn("prompt_text", reference_audio)
        self.assertNotIn("also_use_as_reference", reference_audio)

    def test_last_speech_ultimate_cloning_forwards_prompt_text(self) -> None:
        settings = self._settings({
            "backend": "voxcpm2",
            "voxcpm2": {
                "languages": {
                    "nl": {
                        "mode": "reference_audio",
                        "reference_source": "last_speech",
                        "trim_seconds": 4,
                    },
                },
                "ultimate_cloning": {
                    "last_speech": {"enabled": True, "also_use_as_reference": False},
                },
            },
        })

        ref_dir = (TTS_ROOT / "ref_for_test").resolve()
        ref_dir.mkdir(parents=True, exist_ok=True)
        ref_wav = ref_dir / "asr_clip.wav"
        ref_wav.write_bytes(_silent_wav(seconds=1.5))
        self.addCleanup(lambda: shutil.rmtree(ref_dir, ignore_errors=True))

        fake_pool = FakeTtsPool()
        session_id = "conv_test_uc1_last"
        self.addCleanup(lambda: shutil.rmtree(TTS_ROOT / session_id, ignore_errors=True))

        with mock.patch("app.tts_bridge._post_json", side_effect=fake_pool.post_json):
            TTSBridge().synthesize(
                session_id=session_id,
                text="Hallo",
                language="Dutch",
                settings=settings,
                reference_wav_path=str(ref_wav),
                reference_prompt_text="Dit is wat ik net zei.",
            )

        reference_audio = fake_pool.calls[0]["payload"]["voice"]["reference_audio"]
        self.assertEqual(reference_audio["prompt_text"], "Dit is wat ik net zei.")
        self.assertFalse(reference_audio["also_use_as_reference"])

    def test_tts_settings_snapshot_normalizes_stable_gender(self) -> None:
        settings, errors = tts_settings_snapshot({
            "backend": "voxcpm2",
            "voxcpm2": {
                "languages": {
                    "nl": {
                        "mode": "reference_audio",
                        "reference_source": "stable_generated",
                        "trim_seconds": 6,
                        "stable_gender": "female",
                    },
                    "it": {
                        "mode": "reference_audio",
                        "reference_source": "stable_generated",
                        "trim_seconds": 6,
                    },
                },
            },
        })

        self.assertEqual(errors, {})
        self.assertEqual(settings["voxcpm2"]["languages"]["nl"]["stable_gender"], "female")
        # Missing stable_gender defaults to female.
        self.assertEqual(settings["voxcpm2"]["languages"]["it"]["stable_gender"], "female")
        # last_speech entries do not carry a stable_gender field.
        settings, errors = tts_settings_snapshot({
            "voxcpm2": {
                "languages": {
                    "nl": {
                        "mode": "reference_audio",
                        "reference_source": "last_speech",
                        "trim_seconds": 6,
                    },
                },
            },
        })
        self.assertEqual(errors, {})
        self.assertNotIn("stable_gender", settings["voxcpm2"]["languages"]["nl"])

    def test_tts_settings_snapshot_replaces_languages_map_atomically(self) -> None:
        first_settings, errors = tts_settings_snapshot({
            "backend": "voxcpm2",
            "voxcpm2": {
                "languages": {
                    "de": {"mode": "description", "identity": "adult_man", "texture": "gentle_and_warm"},
                },
            },
        })
        self.assertEqual(errors, {})
        self.assertEqual(set(first_settings["voxcpm2"]["languages"]), {"de"})

        settings, errors = tts_settings_snapshot({
            "backend": "voxcpm2",
            "voxcpm2": {
                "languages": {
                    "nl": {
                        "mode": "reference_audio",
                        "reference_source": "last_speech",
                        "trim_seconds": 5,
                    },
                },
            },
        })

        self.assertEqual(errors, {})
        self.assertEqual(set(settings["voxcpm2"]["languages"]), {"nl"})
        self.assertEqual(
            settings["voxcpm2"]["languages"]["nl"],
            {
                "mode": "reference_audio",
                "texture": "",
                "preset": "",
                "reference_source": "last_speech",
                "trim_seconds": 5.0,
                "trim_to_source": False,
            },
        )

    def test_tts_settings_snapshot_rejects_unknown_backend(self) -> None:
        _, errors = tts_settings_snapshot({"backend": "stub-tts"})

        self.assertIn("backend", errors)

    def test_settings_payload_exposes_user_facing_options(self) -> None:
        payload = tts_settings_payload()

        self.assertEqual(
            [backend["value"] for backend in payload["options"]["backends"]],
            ["kokoro", "voxcpm2", "nanovllm_voxcpm"],
        )
        self.assertIn("English", payload["options"]["kokoro_voices"])
        self.assertEqual(
            [option["value"] for option in payload["options"]["voxcpm2_modes"]],
            ["description", "reference_audio"],
        )
        self.assertEqual(
            [option["value"] for option in payload["options"]["voxcpm2_genders"]],
            ["female", "male"],
        )
        identity_values = [option["value"] for option in payload["options"]["voxcpm2_identities"]]
        self.assertIn("adult_woman", identity_values)
        self.assertIn("elderly_man", identity_values)
        texture_values = [option["value"] for option in payload["options"]["voxcpm2_textures"]]
        self.assertEqual(texture_values[0], "")
        self.assertIn("gentle_and_warm", texture_values)
        reference_sources = payload["options"]["voxcpm2_reference_sources"]
        self.assertEqual(
            [option["value"] for option in reference_sources],
            ["last_speech", "stable_generated"],
        )
        self.assertFalse(reference_sources[0]["disabled"])
        self.assertFalse(reference_sources[1]["disabled"])
        ultimate = payload["voxcpm2"]["ultimate_cloning"]
        self.assertTrue(ultimate["stable_generated"]["enabled"])
        self.assertTrue(ultimate["stable_generated"]["also_use_as_reference"])
        self.assertFalse(ultimate["last_speech"]["enabled"])
        self.assertTrue(ultimate["last_speech"]["also_use_as_reference"])

    def test_settings_payload_exposes_only_loaded_tts_pool_models(self) -> None:
        self.loaded_models.return_value = {"kokoro", "nanovllm_voxcpm"}

        payload = tts_settings_payload()

        self.assertEqual(
            [backend["value"] for backend in payload["options"]["backends"]],
            ["kokoro", "nanovllm_voxcpm"],
        )

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
