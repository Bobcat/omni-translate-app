from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.sessions import ConversationSession
from app.sessions import ConversationSessionManager


class SessionRetentionTests(unittest.TestCase):
    def test_connected_session_does_not_expire_while_in_use(self) -> None:
        manager = ConversationSessionManager()
        manager._sessions["conv_active"] = ConversationSession(
            session_id="conv_active",
            created_unix=0,
            expires_unix=10,
            side_a_language="Dutch",
            side_b_language="English",
            tts_fairness_key="principal_test",
            ws_connected=True,
        )

        removed = manager.cleanup_expired(now=11)

        self.assertEqual(removed, 0)
        self.assertIn("conv_active", manager._sessions)

    def test_expired_session_removes_transcript_and_tts_artifacts(self) -> None:
        manager = ConversationSessionManager()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_root = root / "exports"
            tts_root = root / "tts"
            asr_root = root / "asr"
            export_root.mkdir()
            tts_root.mkdir()
            asr_root.mkdir()
            transcript = export_root / "conv_test.pc"
            transcript.write_text("temporary transcript", encoding="utf-8")
            tts_session = tts_root / "conv_test"
            tts_session.mkdir()
            (tts_session / "speech.wav").write_bytes(b"wav")
            asr_session = asr_root / "conv_test"
            asr_session.mkdir()
            (asr_session / "source.wav").write_bytes(b"wav")
            manager._sessions["conv_test"] = ConversationSession(
                session_id="conv_test",
                created_unix=0,
                expires_unix=10,
                side_a_language="Dutch",
                side_b_language="English",
                tts_fairness_key="principal_test",
                pc_export_path=str(transcript),
            )

            with (
                patch("app.sessions.PC_EXPORT_ROOT", export_root),
                patch("app.sessions.TTS_ROOT", tts_root),
                patch("app.sessions.ASR_CHUNKS_ROOT", asr_root),
            ):
                removed = manager.cleanup_expired(now=11)

            self.assertEqual(removed, 1)
            self.assertFalse(transcript.exists())
            self.assertFalse(tts_session.exists())
            self.assertFalse(asr_session.exists())

    def test_orphan_cleanup_preserves_active_and_recent_artifacts(self) -> None:
        manager = ConversationSessionManager()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_root = root / "exports"
            tts_root = root / "tts"
            asr_root = root / "asr"
            export_root.mkdir()
            tts_root.mkdir()
            asr_root.mkdir()
            old_export = export_root / "conv_old.pc"
            active_export = export_root / "conv_active.pc"
            recent_export = export_root / "conv_recent.pc"
            for path in (old_export, active_export, recent_export):
                path.write_text("transcript", encoding="utf-8")
            old_tts = tts_root / "conv_old"
            active_tts = tts_root / "conv_active"
            recent_tts = tts_root / "conv_recent"
            old_asr = asr_root / "conv_old"
            active_asr = asr_root / "conv_active"
            recent_asr = asr_root / "conv_recent"
            for path in (old_tts, active_tts, recent_tts, old_asr, active_asr, recent_asr):
                path.mkdir()
            os.utime(old_export, (100, 100))
            os.utime(active_export, (100, 100))
            os.utime(recent_export, (950, 950))
            os.utime(old_tts, (100, 100))
            os.utime(active_tts, (100, 100))
            os.utime(recent_tts, (950, 950))
            os.utime(old_asr, (100, 100))
            os.utime(active_asr, (100, 100))
            os.utime(recent_asr, (950, 950))
            manager._sessions["conv_active"] = ConversationSession(
                session_id="conv_active",
                created_unix=0,
                expires_unix=2000,
                side_a_language="Dutch",
                side_b_language="English",
                tts_fairness_key="principal_test",
            )

            with (
                patch("app.sessions.PC_EXPORT_ROOT", export_root),
                patch("app.sessions.TTS_ROOT", tts_root),
                patch("app.sessions.ASR_CHUNKS_ROOT", asr_root),
                patch("app.sessions.get_int", return_value=100),
            ):
                manager.cleanup_expired(now=1000, include_orphans=True)

            self.assertFalse(old_export.exists())
            self.assertFalse(old_tts.exists())
            self.assertFalse(old_asr.exists())
            self.assertTrue(active_export.exists())
            self.assertTrue(active_tts.exists())
            self.assertTrue(active_asr.exists())
            self.assertTrue(recent_export.exists())
            self.assertTrue(recent_tts.exists())
            self.assertTrue(recent_asr.exists())


if __name__ == "__main__":
    unittest.main()
