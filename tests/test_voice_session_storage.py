from __future__ import annotations

import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from app.voice import session_storage
from app.voice.session_storage import SessionArtifactLimitExceeded


class VoiceSessionStorageTests(unittest.TestCase):
    def test_limit_counts_asr_and_tts_artifacts_together(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            roots = (root / "asr", root / "tts")
            with (
                patch.object(session_storage, "SESSION_ARTIFACT_ROOTS", roots),
                patch.object(session_storage, "session_artifact_limit_bytes", return_value=10),
            ):
                session_storage.write_session_artifact(
                    "session-1",
                    roots[0] / "session-1" / "asr.wav",
                    b"123456",
                )
                session_storage.write_session_artifact(
                    "session-1",
                    roots[1] / "session-1" / "tts.wav",
                    b"7890",
                )

                self.assertEqual(session_storage.session_artifact_bytes("session-1"), 10)
                with self.assertRaises(SessionArtifactLimitExceeded) as caught:
                    session_storage.write_session_artifact(
                        "session-1",
                        roots[1] / "session-1" / "too-much.wav",
                        b"x",
                    )

            self.assertEqual(caught.exception.limit_bytes, 10)
            self.assertFalse((roots[1] / "session-1" / "too-much.wav").exists())

    def test_overwrite_replaces_previous_size_in_limit_calculation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            roots = (root / "asr", root / "tts")
            path = roots[0] / "session-1" / "artifact.wav"
            with (
                patch.object(session_storage, "SESSION_ARTIFACT_ROOTS", roots),
                patch.object(session_storage, "session_artifact_limit_bytes", return_value=5),
            ):
                session_storage.write_session_artifact("session-1", path, b"1234")
                session_storage.write_session_artifact("session-1", path, b"12345")

            self.assertEqual(path.read_bytes(), b"12345")

    def test_usage_is_scanned_only_before_the_first_write(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            roots = (root / "asr", root / "tts")
            with (
                patch.object(session_storage, "SESSION_ARTIFACT_ROOTS", roots),
                patch.object(session_storage, "session_artifact_limit_bytes", return_value=10),
                patch.object(
                    session_storage,
                    "_directory_bytes",
                    wraps=session_storage._directory_bytes,
                ) as directory_bytes,
            ):
                session_storage.write_session_artifact(
                    "session-scan",
                    roots[0] / "session-scan" / "one.wav",
                    b"1234",
                )
                session_storage.write_session_artifact(
                    "session-scan",
                    roots[1] / "session-scan" / "two.wav",
                    b"5678",
                )

            self.assertEqual(directory_bytes.call_count, 2)

    def test_concurrent_writes_share_one_session_budget(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            roots = (root / "asr", root / "tts")
            with (
                patch.object(session_storage, "SESSION_ARTIFACT_ROOTS", roots),
                patch.object(session_storage, "session_artifact_limit_bytes", return_value=1000),
            ):
                session_storage.write_session_artifact(
                    "session-concurrent",
                    roots[0] / "session-concurrent" / "existing.wav",
                    b"x" * 400,
                )

                def attempt(path: Path) -> str:
                    try:
                        session_storage.write_session_artifact(
                            "session-concurrent",
                            path,
                            b"y" * 600,
                        )
                    except SessionArtifactLimitExceeded:
                        return "limited"
                    return "written"

                with ThreadPoolExecutor(max_workers=2) as executor:
                    results = list(
                        executor.map(
                            attempt,
                            (
                                roots[0] / "session-concurrent" / "asr.wav",
                                roots[1] / "session-concurrent" / "tts.wav",
                            ),
                        )
                    )

                self.assertEqual(sorted(results), ["limited", "written"])
                self.assertEqual(
                    session_storage.session_artifact_bytes("session-concurrent"),
                    1000,
                )

    def test_session_id_must_match_the_server_generated_alphabet(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            roots = (root / "asr", root / "tts")
            with patch.object(session_storage, "SESSION_ARTIFACT_ROOTS", roots):
                with self.assertRaisesRegex(ValueError, "invalid_session_id"):
                    session_storage.write_session_artifact(
                        "conv.2026.abc",
                        roots[0] / "conv_2026_abc" / "artifact.wav",
                        b"data",
                    )


if __name__ == "__main__":
    unittest.main()
