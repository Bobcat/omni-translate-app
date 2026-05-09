from __future__ import annotations

import csv
import io
import json
import unittest

from app.asr_pc_export import live_pc_events_to_text
from app.asr_pc_export import pc_export_filename
from app.asr_pc_export import pc_export_path
from app.sessions import ConversationSessionManager


class ASRPCExportTests(unittest.TestCase):
    def test_live_pc_events_include_fw_summary_and_debug_json(self) -> None:
        text = live_pc_events_to_text(
            [
                {
                    "kind": "p",
                    "speech_start_ms": 100,
                    "speech_end_ms": 900,
                    "text": "Hallo\nwereld",
                    "reason": "preview_applied",
                    "lane_id": "a_to_b",
                    "turn_id": "turn_1",
                    "line_number": 2,
                    "asr_debug": {
                        "backend": "faster_whisper_direct",
                        "request_id": "req-1",
                        "segments": [
                            {
                                "segment_id": "s0001",
                                "text": "Hallo wereld",
                                "t0_ms": 100,
                                "t1_ms": 900,
                                "avg_logprob": -0.2,
                                "compression_ratio": 1.1,
                                "no_speech_prob": 0.03,
                                "temperature": 0.0,
                            },
                            {
                                "segment_id": "s0002",
                                "text": "later",
                                "t0_ms": 900,
                                "t1_ms": 1200,
                                "avg_logprob": -0.4,
                                "compression_ratio": 1.5,
                                "no_speech_prob": 0.08,
                                "temperature": 0.2,
                            },
                        ],
                    },
                }
            ]
        )

        rows = list(csv.DictReader(io.StringIO(text)))
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["kind"], "p")
        self.assertEqual(row["text"], "Hallo wereld")
        self.assertEqual(row["backend"], "faster_whisper_direct")
        self.assertEqual(row["request_id"], "req-1")
        self.assertEqual(row["segment_count"], "2")
        self.assertEqual(row["avg_logprob_mean"], "-0.3")
        self.assertEqual(row["avg_logprob_min"], "-0.4")
        self.assertEqual(row["compression_ratio_max"], "1.5")
        self.assertEqual(row["no_speech_prob_max"], "0.08")
        self.assertEqual(row["temperature_max"], "0.2")
        debug = json.loads(row["asr_debug_json"])
        self.assertEqual(debug["segments"][0]["avg_logprob"], -0.2)

    def test_pc_export_filename_is_safe(self) -> None:
        self.assertEqual(pc_export_filename("conv/a b"), "conv_a_b.pc")

    def test_session_close_writes_pc_export_file(self) -> None:
        manager = ConversationSessionManager()
        session = manager.create_session(side_a_language="Dutch", side_b_language="English")
        session_id = session["session_id"]
        path = pc_export_path(session_id)
        try:
            manager.append_pc_event(
                session_id,
                {
                    "kind": "c",
                    "speech_start_ms": 0,
                    "speech_end_ms": 500,
                    "text": "Hallo",
                },
            )
            manager.close(session_id, reason="test")
            self.assertTrue(path.exists())
            self.assertIn("Hallo", path.read_text(encoding="utf-8"))
        finally:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
