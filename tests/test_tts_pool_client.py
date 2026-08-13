from __future__ import annotations

import unittest
from unittest import mock
import uuid

from google.protobuf.struct_pb2 import Struct

from app.saas_setup import tts_fairness_key_for_principal
from app.upstreams.tts_pool import client
from app.upstreams.tts_pool.v1 import tts_pb2
from saas.principals import Principal


class _RecordingStub:
    def __init__(self, events: list[tts_pb2.SynthesisEvent]) -> None:
        self.events = events
        self.request = None
        self.timeout = None

    def Synthesize(self, request, *, timeout):
        self.request = request
        self.timeout = timeout
        return iter(self.events)


def _successful_events() -> list[tts_pb2.SynthesisEvent]:
    metrics = Struct()
    metrics.update({"queue_ms": 1.5})
    metadata = Struct()
    metadata.update({"engine": "fake"})
    return [
        tts_pb2.SynthesisEvent(
            started=tts_pb2.Started(
                response_id="ttsresp_test",
                model="nanovllm_voxcpm",
                sample_rate_hz=16_000,
                channel_count=1,
                encoding=tts_pb2.AUDIO_ENCODING_PCM_S16LE,
            )
        ),
        tts_pb2.SynthesisEvent(
            audio_chunk=tts_pb2.AudioChunk(
                sequence_number=0,
                first_sample=0,
                pcm=b"\x01\x00\x02\x00",
            )
        ),
        tts_pb2.SynthesisEvent(
            completed=tts_pb2.Completed(
                total_sample_count=2,
                duration_ms=1,
                chunk_count=1,
                metrics=metrics,
                metadata=metadata,
            )
        ),
    ]


class TtsPoolClientTests(unittest.TestCase):
    def test_synthesis_uses_binary_reference_and_validates_stream(self) -> None:
        stub = _RecordingStub(_successful_events())
        payload = {
            "model": "nanovllm_voxcpm",
            "input": "Hallo",
            "language": "Dutch",
            "voice": {
                "instructions": "Warm voice",
                "reference_audio": {
                    "mime_type": "audio/wav",
                    "data": b"RIFF-test",
                    "max_duration_s": 3.0,
                },
            },
        }
        with mock.patch.object(client, "_channel", return_value=object()), mock.patch.object(
            client.tts_pb2_grpc,
            "TTSServiceStub",
            return_value=stub,
        ):
            result = client.synthesize_tts(
                payload,
                fairness_key="principal_test",
                timeout_s=10.0,
            )

        self.assertEqual(stub.request.fairness_key, "principal_test")
        self.assertEqual(stub.request.voice.reference_audio.data, b"RIFF-test")
        self.assertEqual(stub.timeout, 10.0)
        self.assertEqual(result.pcm, b"\x01\x00\x02\x00")
        self.assertEqual(result.metrics["queue_ms"], 1.5)
        self.assertEqual(result.metadata["engine"], "fake")
        self.assertTrue(result.wav_bytes().startswith(b"RIFF"))

    def test_out_of_order_chunk_is_rejected(self) -> None:
        events = _successful_events()
        events[1].audio_chunk.sequence_number = 2
        stub = _RecordingStub(events)
        with mock.patch.object(client, "_channel", return_value=object()), mock.patch.object(
            client.tts_pb2_grpc,
            "TTSServiceStub",
            return_value=stub,
        ):
            with self.assertRaisesRegex(ValueError, "out_of_order"):
                client.synthesize_tts(
                    {"model": "model", "input": "text", "language": "English"},
                    fairness_key="principal_test",
                    timeout_s=10.0,
                )

    def test_fairness_key_is_stable_and_principal_scoped(self) -> None:
        first = Principal(
            tenant="default",
            kind="user",
            id=uuid.UUID("00000000-0000-0000-0000-000000000001"),
            plan_code="free",
        )
        second = Principal(
            tenant="default",
            kind="user",
            id=uuid.UUID("00000000-0000-0000-0000-000000000002"),
            plan_code="free",
        )

        self.assertEqual(
            tts_fairness_key_for_principal(first),
            tts_fairness_key_for_principal(first),
        )
        self.assertNotEqual(
            tts_fairness_key_for_principal(first),
            tts_fairness_key_for_principal(second),
        )
        self.assertNotIn(str(first.id), tts_fairness_key_for_principal(first))


if __name__ == "__main__":
    unittest.main()
