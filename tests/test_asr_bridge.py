from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from app import config as app_config
from app.asr_bridge import LiveASRPoolBridge


class _RecordingPoolClient:
    def __init__(self) -> None:
        self.request = None

    def submit_audio(self, request):
        self.request = request
        return SimpleNamespace(request_id=request.request_id)


class ASRBridgeTests(unittest.TestCase):
    def test_enqueue_passes_direct_fw_options_and_json_outputs(self) -> None:
        settings = {
            "live": {
                "asr": {
                    "backend": "faster_whisper_direct",
                    "align_enabled": False,
                    "diarize_enabled": False,
                    "beam_size": 2,
                    "chunk_size": 10,
                    "chunk_length": 4,
                    "vad_filter": False,
                    "vad_parameters": {"threshold": 0.4},
                    "word_timestamps": True,
                    "max_new_tokens": 64,
                    "hotwords": "omniscripta realtime",
                    "compression_ratio_threshold": 2.1,
                    "log_prob_threshold": -0.7,
                    "no_speech_threshold": 0.5,
                    "language_detection_threshold": 0.6,
                    "language_detection_segments": 2,
                }
            }
        }
        with tempfile.TemporaryDirectory() as tmp, patch.dict(app_config.SETTINGS, settings, clear=True):
            fake_client = _RecordingPoolClient()
            bridge = LiveASRPoolBridge(session_id="sess-1", sample_rate_hz=16000, channels=1)
            bridge._client = fake_client
            bridge.chunks_root = Path(tmp)

            bridge.enqueue_pcm16(
                lane_id="a_to_b",
                chunk_index=1,
                t0_ms=0,
                t1_ms=200,
                pcm16le=b"\0\0" * 1600,
                language="nl",
            )

        request = fake_client.request
        self.assertIsNotNone(request)
        self.assertEqual(request.outputs.text, True)
        self.assertEqual(request.outputs.segments, True)
        self.assertEqual(request.outputs.srt, False)
        self.assertEqual(request.outputs.srt_inline, False)
        self.assertEqual(request.options.asr_backend, "faster_whisper_direct")
        self.assertEqual(request.options.beam_size, 2)
        self.assertIsNone(request.options.chunk_size)
        self.assertEqual(request.options.chunk_length, 4)
        self.assertEqual(request.options.vad_filter, False)
        self.assertEqual(request.options.vad_parameters, {"threshold": 0.4})
        self.assertEqual(request.options.word_timestamps, True)
        self.assertEqual(request.options.max_new_tokens, 64)
        self.assertEqual(request.options.hotwords, "omniscripta realtime")
        self.assertEqual(request.options.compression_ratio_threshold, 2.1)
        self.assertEqual(request.options.log_prob_threshold, -0.7)
        self.assertEqual(request.options.no_speech_threshold, 0.5)
        self.assertEqual(request.options.language_detection_threshold, 0.6)
        self.assertEqual(request.options.language_detection_segments, 2)

    def test_enqueue_uses_session_live_settings(self) -> None:
        live_settings = {
            "asr": {
                "backend": "faster_whisper_direct",
                "beam_size": 3,
                "chunk_size": 10,
                "chunk_length": 5,
                "vad_filter": False,
            }
        }
        with tempfile.TemporaryDirectory() as tmp:
            fake_client = _RecordingPoolClient()
            bridge = LiveASRPoolBridge(
                session_id="sess-live",
                sample_rate_hz=16000,
                channels=1,
                live_settings=live_settings,
            )
            bridge._client = fake_client
            bridge.chunks_root = Path(tmp)

            bridge.enqueue_pcm16(
                lane_id="a_to_b",
                chunk_index=1,
                t0_ms=0,
                t1_ms=200,
                pcm16le=b"\0\0" * 1600,
                language="nl",
            )

        request = fake_client.request
        self.assertIsNotNone(request)
        self.assertEqual(request.options.asr_backend, "faster_whisper_direct")
        self.assertEqual(request.options.beam_size, 3)
        self.assertIsNone(request.options.chunk_size)
        self.assertEqual(request.options.chunk_length, 5)
        self.assertEqual(request.options.vad_filter, False)

    def test_terminal_result_prefers_json_segments_over_srt_text(self) -> None:
        bridge = LiveASRPoolBridge(session_id="sess-2", sample_rate_hz=16000, channels=1)
        with bridge._lock:
            bridge._request_meta["req-1"] = {"feed_generation": 0, "t0_ms": 1000, "t1_ms": 1400}
            bridge._terminal_events["req-1"] = {
                "state": "completed",
                "response": {
                    "result": {
                        "text": "JSON text",
                        "segments": [
                            {
                                "text": "JSON segment",
                                "start": 0.1,
                                "end": 0.4,
                                "speaker": "SPEAKER_01",
                                "avg_logprob": -0.25,
                                "compression_ratio": 1.2,
                                "no_speech_prob": 0.03,
                                "temperature": 0.0,
                            }
                        ],
                        "srt_text": "1\n00:00:00,000 --> 00:00:00,100\nSRT segment\n",
                    }
                },
            }

        result = bridge.take_terminal_result("req-1", t0_offset_ms=1000)

        self.assertEqual(result.ok, True)
        self.assertEqual(result.text, "JSON text")
        self.assertEqual(
            result.segments,
            [
                {
                    "segment_id": "s0001",
                    "text": "JSON segment",
                    "t0_ms": 1100,
                    "t1_ms": 1400,
                    "speaker": "SPEAKER_01",
                    "asr_debug": {
                        "temperature": 0.0,
                        "avg_logprob": -0.25,
                        "compression_ratio": 1.2,
                        "no_speech_prob": 0.03,
                    },
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
