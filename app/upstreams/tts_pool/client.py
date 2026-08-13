"""Single-channel gRPC client for TTS-pool synthesis."""

from __future__ import annotations

from dataclasses import dataclass
import io
import threading
from typing import Any
import wave

import grpc
from google.protobuf.json_format import MessageToDict

from app.config import get_int
from app.config import get_str

from .v1 import tts_pb2
from .v1 import tts_pb2_grpc


_CHANNEL: grpc.Channel | None = None
_CHANNEL_LOCK = threading.Lock()


class TtsPoolRpcError(RuntimeError):
    pass


@dataclass(frozen=True)
class TtsSynthesisResult:
    response_id: str
    model: str
    pcm: bytes
    sample_rate_hz: int
    channel_count: int
    duration_ms: int
    metrics: dict[str, Any]
    metadata: dict[str, Any]

    def wav_bytes(self) -> bytes:
        output = io.BytesIO()
        with wave.open(output, "wb") as writer:
            writer.setnchannels(self.channel_count)
            writer.setsampwidth(2)
            writer.setframerate(self.sample_rate_hz)
            writer.writeframes(self.pcm)
        return output.getvalue()


def open_tts_pool_channel() -> None:
    global _CHANNEL
    with _CHANNEL_LOCK:
        if _CHANNEL is not None:
            return
        _CHANNEL = grpc.insecure_channel(
            _grpc_target(),
            options=(
                (
                    "grpc.max_receive_message_length",
                    get_int("tts_pool.grpc_max_receive_message_bytes", 16_777_216, min_value=1024),
                ),
                (
                    "grpc.max_send_message_length",
                    get_int("tts_pool.grpc_max_send_message_bytes", 16_777_216, min_value=1024),
                ),
            ),
        )


def close_tts_pool_channel() -> None:
    global _CHANNEL
    with _CHANNEL_LOCK:
        channel = _CHANNEL
        _CHANNEL = None
    if channel is not None:
        channel.close()


def synthesize_tts(
    payload: dict[str, Any],
    *,
    fairness_key: str,
    timeout_s: float,
) -> TtsSynthesisResult:
    stable_key = str(fairness_key or "").strip()
    if not stable_key:
        raise ValueError("tts_fairness_key_required")
    channel = _channel()
    call = tts_pb2_grpc.TTSServiceStub(channel).Synthesize(
        _request_from_payload(payload, fairness_key=stable_key),
        timeout=timeout_s,
    )
    started: tts_pb2.Started | None = None
    completed: tts_pb2.Completed | None = None
    chunks: list[bytes] = []
    next_sequence = 0
    next_sample = 0
    try:
        for event in call:
            kind = event.WhichOneof("payload")
            if completed is not None:
                raise ValueError("tts_pool_event_after_completed")
            if kind == "started":
                if started is not None or chunks:
                    raise ValueError("tts_pool_started_event_out_of_order")
                if event.started.encoding != tts_pb2.AUDIO_ENCODING_PCM_S16LE:
                    raise ValueError("tts_pool_unsupported_audio_encoding")
                if event.started.sample_rate_hz <= 0 or event.started.channel_count <= 0:
                    raise ValueError("tts_pool_invalid_audio_format")
                started = event.started
            elif kind == "audio_chunk":
                if started is None:
                    raise ValueError("tts_pool_audio_before_started")
                chunk = event.audio_chunk
                if chunk.sequence_number != next_sequence or chunk.first_sample != next_sample:
                    raise ValueError("tts_pool_audio_chunk_out_of_order")
                frame_bytes = int(started.channel_count) * 2
                if len(chunk.pcm) % frame_bytes:
                    raise ValueError("tts_pool_invalid_pcm_chunk")
                chunks.append(bytes(chunk.pcm))
                next_sequence += 1
                next_sample += len(chunk.pcm) // frame_bytes
            elif kind == "completed":
                completed = event.completed
            else:
                raise ValueError("tts_pool_empty_event")
    except grpc.RpcError as exc:
        metadata = dict(exc.trailing_metadata() or ())
        code = str(metadata.get("tts-error-code") or "tts_pool_rpc_failed")
        status = exc.code().name.lower()
        detail = str(exc.details() or code)
        raise TtsPoolRpcError(f"tts_pool_grpc_{status}: {code}: {detail}") from exc

    if started is None or completed is None:
        raise ValueError("tts_pool_incomplete_event_stream")
    if completed.chunk_count != next_sequence or completed.total_sample_count != next_sample:
        raise ValueError("tts_pool_completed_counts_mismatch")
    return TtsSynthesisResult(
        response_id=started.response_id,
        model=started.model,
        pcm=b"".join(chunks),
        sample_rate_hz=int(started.sample_rate_hz),
        channel_count=int(started.channel_count),
        duration_ms=int(completed.duration_ms),
        metrics=MessageToDict(completed.metrics, preserving_proto_field_name=True),
        metadata=MessageToDict(completed.metadata, preserving_proto_field_name=True),
    )


def _channel() -> grpc.Channel:
    open_tts_pool_channel()
    with _CHANNEL_LOCK:
        if _CHANNEL is None:
            raise RuntimeError("tts_pool_channel_unavailable")
        return _CHANNEL


def _grpc_target() -> str:
    return get_str("tts_pool.grpc_target", "127.0.0.1:8021").strip() or "127.0.0.1:8021"


def _request_from_payload(payload: dict[str, Any], *, fairness_key: str) -> tts_pb2.SynthesisRequest:
    voice_payload = payload.get("voice") if isinstance(payload.get("voice"), dict) else {}
    generation_payload = (
        payload.get("generation") if isinstance(payload.get("generation"), dict) else {}
    )
    return tts_pb2.SynthesisRequest(
        model=str(payload.get("model") or ""),
        input=str(payload.get("input") or ""),
        language=str(payload.get("language") or ""),
        fairness_key=fairness_key,
        voice=_voice_from_payload(voice_payload),
        generation=_generation_from_payload(generation_payload),
        output_encoding=tts_pb2.AUDIO_ENCODING_PCM_S16LE,
    )


def _voice_from_payload(payload: dict[str, Any]) -> tts_pb2.VoiceSpec:
    voice = tts_pb2.VoiceSpec(
        preset=str(payload.get("preset") or ""),
        instructions=str(payload.get("instructions") or ""),
    )
    reference = payload.get("reference_audio")
    if isinstance(reference, dict):
        message = tts_pb2.ReferenceAudio(
            mime_type=str(reference.get("mime_type") or "audio/wav"),
            data=bytes(reference.get("data") or b""),
            prompt_text=str(reference.get("prompt_text") or ""),
        )
        if reference.get("max_duration_s") is not None:
            message.max_duration_s = float(reference["max_duration_s"])
        if "also_use_as_reference" in reference:
            message.also_use_as_reference = bool(reference["also_use_as_reference"])
        voice.reference_audio.CopyFrom(message)
    return voice


def _generation_from_payload(payload: dict[str, Any]) -> tts_pb2.GenerationParams:
    generation = tts_pb2.GenerationParams()
    _copy_optional_fields(generation.kokoro, payload.get("kokoro"), ("speed",))
    _copy_optional_fields(
        generation.voxcpm2,
        payload.get("voxcpm2"),
        ("cfg_value", "inference_timesteps", "normalize", "denoise"),
    )
    _copy_optional_fields(
        generation.nanovllm_voxcpm,
        payload.get("nanovllm_voxcpm"),
        ("cfg_value", "temperature", "max_generate_length"),
    )
    return generation


def _copy_optional_fields(message: object, values: object, fields: tuple[str, ...]) -> None:
    if not isinstance(values, dict):
        return
    for field_name in fields:
        value = values.get(field_name)
        if value is not None:
            setattr(message, field_name, value)
