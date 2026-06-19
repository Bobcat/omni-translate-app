import io
import json
import shutil
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

from app import voice_library


class VoiceLibraryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_root = Path(tempfile.mkdtemp(prefix="test_voice_library_"))
        self.root_patcher = mock.patch.object(voice_library, "STABLE_VOICE_LIBRARY_ROOT", self.tmp_root)
        self.root_patcher.start()
        self.addCleanup(self.root_patcher.stop)
        self.addCleanup(lambda: shutil.rmtree(self.tmp_root, ignore_errors=True))

    def test_stable_status_includes_current_and_pending_durations(self) -> None:
        sample_dir = self.tmp_root / "en" / "female"
        sample_dir.mkdir(parents=True)
        (sample_dir / "audio.wav").write_bytes(_silent_wav(seconds=1.25))
        (sample_dir / "audio.pending.wav").write_bytes(_silent_wav(seconds=2.5))
        (sample_dir / "meta.json").write_text(
            json.dumps({"generated_at": "2026-06-19T08:00:00Z"}),
            encoding="utf-8",
        )
        (sample_dir / "meta.pending.json").write_text(
            json.dumps({"generated_at": "2026-06-19T08:01:00Z"}),
            encoding="utf-8",
        )

        status = voice_library.stable_voice_language_status("en")
        sample = status["samples"]["female"]

        self.assertTrue(sample["exists"])
        self.assertEqual(sample["generated_at"], "2026-06-19T08:00:00Z")
        self.assertEqual(sample["duration_ms"], 1250)
        self.assertTrue(sample["has_pending"])
        self.assertEqual(sample["pending_generated_at"], "2026-06-19T08:01:00Z")
        self.assertEqual(sample["pending_duration_ms"], 2500)


def _silent_wav(*, seconds: float, sample_rate: int = 16000) -> bytes:
    frames = int(seconds * sample_rate)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(b"\x00\x00" * frames)
    return buffer.getvalue()
