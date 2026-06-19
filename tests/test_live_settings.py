from __future__ import annotations

import unittest
from unittest.mock import patch

from app import config as app_config
from app.live_settings import default_live_settings
from app.live_settings import live_runner_config
from app.live_settings import merge_live_settings
from app.live_settings import normalize_live_settings_delta


class LiveSettingsTests(unittest.TestCase):
    def test_default_force_commit_silence_is_snappy_cap(self) -> None:
        settings = default_live_settings()
        speech_gate = settings["rolling"]["speech_gate"]

        self.assertEqual(speech_gate["silence_enter_ms"], 900)
        self.assertEqual(speech_gate["force_commit_silence_ms"], 1200)

    def test_live_delta_accepts_backend_and_rolling_fields(self) -> None:
        delta, errors = normalize_live_settings_delta(
            {
                "asr": {"backend": "faster_whisper_direct", "chunk_length": 4},
                "rolling": {
                    "min_infer_audio_ms": 250,
                    "speech_gate": {"force_commit_silence_ms": 1200},
                },
            },
            live_update=True,
        )

        self.assertEqual(errors, [])
        merged = merge_live_settings(default_live_settings(), delta)
        self.assertEqual(merged["asr"]["backend"], "faster_whisper_direct")
        self.assertEqual(merged["asr"]["chunk_length"], 4)
        self.assertEqual(merged["rolling"]["min_infer_audio_ms"], 250)
        self.assertEqual(merged["rolling"]["speech_gate"]["force_commit_silence_ms"], 1200)

    def test_live_delta_rejects_non_live_vad_field(self) -> None:
        delta, errors = normalize_live_settings_delta(
            {"rolling": {"vad": {"threshold": 0.4}}},
            live_update=True,
        )

        self.assertEqual(delta, {})
        self.assertEqual(errors, ["rolling.vad.threshold: not live-updatable"])

    def test_runner_config_keeps_local_vad_venv_server_side(self) -> None:
        with patch.dict(app_config.SETTINGS, {"live": {"rolling": {"vad": {"venv": "/tmp/vad-venv"}}}}, clear=True):
            config = live_runner_config({"rolling": {"vad": {"enabled": True}}})

        self.assertEqual(config["rolling"]["vad"]["venv"], "/tmp/vad-venv")


if __name__ == "__main__":
    unittest.main()
