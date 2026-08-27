"""TTS streaming, cached replay, and playback settlement."""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from app.protocol import event
from app.tts_bridge import TtsReferenceUnavailableError
from app.tts_bridge import get_tts_bridge
from app.tts_bridge import tts_settings_enabled
from app.tts_bridge import tts_uses_asr_reference_wav
from app.upstreams.tts_pool.client import TtsSynthesisCancellation
from app.voice.tasks import cancel_task

if TYPE_CHECKING:
    from app.runtime import ConversationLane
    from app.runtime import ConversationRuntime
    from app.runtime import TurnPart


LOGGER = logging.getLogger("asr_translate_tts.voice.tts_delivery")
LAST_SPEECH_QUALITY_THRESHOLD = 0.7
STREAM_SEND_TIMEOUT_S = 5.0


class _StaleTtsStream(Exception):
    """Stop forwarding a pool stream that no longer belongs to the active turn."""


class TtsDelivery:
    """Own the TTS delivery lifecycle for one conversation runtime."""

    def __init__(
        self,
        runtime: ConversationRuntime,
        *,
        part_target_text: Callable[[TurnPart], str],
    ) -> None:
        self.runtime = runtime
        self.part_target_text = part_target_text
        self.bridge = get_tts_bridge()
        self.cached_turn_artifacts: dict[tuple[str, str], dict[str, Any]] = {}
        self.active_stream_artifacts: dict[str, tuple[str, list[str]]] = {}
        self.stream_generation = 0

    async def replay(self, payload: dict[str, Any]) -> None:
        runtime = self.runtime
        lane_id = str(payload.get("lane_id") or "").strip()
        part_id = str(payload.get("part_id") or "").strip()
        turn = runtime.current_turn
        if not part_id or lane_id != turn.lane_id:
            return
        part = next((item for item in turn.parts if item.part_id == part_id), None)
        if part is None or part.speech_state != "spoken" or not tts_settings_enabled(runtime.tts_settings):
            return
        text = self.part_target_text(part)
        tts_payload = self.cached_turn_artifacts.get((turn.turn_id, part_id))
        if not text or tts_payload is None:
            part.speech_state = "pending"
            runtime._refresh_turn_state()
            await runtime._send_turn_update(reason="tts_replay_unavailable")
            await runtime.lifecycle.send(
                event(
                    "tts_status",
                    runtime.session_id,
                    state="unavailable",
                    reason="tts_replay_unavailable",
                    message="Audio is no longer available",
                    lane_id=lane_id,
                    turn_id=turn.turn_id,
                )
            )
            return
        await runtime.lifecycle.send(
            event(
                "tts_replay_ready",
                runtime.session_id,
                lane_id=lane_id,
                turn_id=turn.turn_id,
                part_id=part_id,
                text=text,
                tts=dict(tts_payload),
            )
        )

    async def run_speak_sequence(
        self,
        lane_id: str,
        turn_id: str,
        part_ids: list[str],
    ) -> None:
        """Synthesize selected bubbles in order while browser playback overlaps."""
        runtime = self.runtime
        lane = runtime.lanes[lane_id]
        current_task = asyncio.current_task()
        try:
            for part_id in part_ids:
                if runtime.current_turn.turn_id != turn_id:
                    return
                target = next(
                    (part for part in runtime.current_turn.parts if part.part_id == part_id),
                    None,
                )
                if target is None or target.speech_state == "spoken":
                    continue
                text = self.part_target_text(target)
                if not text:
                    continue
                sub_task = asyncio.create_task(
                    self.synthesize_turn_clip(lane.lane_id, turn_id, text, [part_id])
                )
                try:
                    await sub_task
                except asyncio.CancelledError:
                    await cancel_task(sub_task)
                    raise
        finally:
            if lane.tts_task is current_task:
                lane.tts_task = None

    async def synthesize_turn_clip(
        self,
        lane_id: str,
        turn_id: str,
        text: str,
        speaking_part_ids: list[str],
    ) -> None:
        runtime = self.runtime
        lane = runtime.lanes[lane_id]
        current_task = asyncio.current_task()
        reference_wav_path, low_quality = _last_speech_reference_choice(
            lane,
            runtime.tts_settings,
        )
        if reference_wav_path is not None or tts_uses_asr_reference_wav(
            lane.target_language,
            settings=runtime.tts_settings,
        ):
            self._set_part_reference_quality(speaking_part_ids, low_quality=low_quality)
        reference_prompt_text = _last_speech_prompt_text(lane, reference_wav_path)
        source_audio_duration_ms = _source_bubble_duration_ms(lane)
        loop = asyncio.get_running_loop()
        stream_artifact_id = ""
        stream_generation = self.stream_generation
        cancellation = TtsSynthesisCancellation()

        async def deliver_from_synthesis(
            payload: dict[str, Any],
            *,
            before_send: Callable[[], None] | None = None,
        ) -> None:
            if (
                cancellation.cancelled
                or runtime.lifecycle.closed
                or stream_generation != self.stream_generation
                or not self._turn_is_speaking(turn_id)
            ):
                raise _StaleTtsStream()
            if before_send is not None:
                before_send()
            await runtime.lifecycle.send(payload)

        def send_from_synthesis(
            payload: dict[str, Any],
            *,
            before_send: Callable[[], None] | None = None,
        ) -> None:
            future = asyncio.run_coroutine_threadsafe(
                deliver_from_synthesis(payload, before_send=before_send),
                loop,
            )
            try:
                future.result(timeout=STREAM_SEND_TIMEOUT_S)
            except concurrent.futures.TimeoutError:
                future.cancel()
                raise

        def stream_started(tts: dict[str, Any]) -> None:
            nonlocal stream_artifact_id
            stream_artifact_id = str(tts.get("artifact_id") or "").strip()

            def mark_active() -> None:
                if stream_artifact_id:
                    self.active_stream_artifacts[stream_artifact_id] = (
                        turn_id,
                        list(speaking_part_ids),
                    )

            send_from_synthesis(
                event(
                    "tts_stream_started",
                    runtime.session_id,
                    lane_id=lane.lane_id,
                    turn_id=turn_id,
                    part_ids=list(speaking_part_ids),
                    tts=tts,
                ),
                before_send=mark_active,
            )

        def audio_chunk(chunk: dict[str, Any]) -> None:
            pcm = bytes(chunk.get("pcm") or b"")
            if not pcm:
                return
            send_from_synthesis(
                event(
                    "tts_stream_chunk",
                    runtime.session_id,
                    lane_id=lane.lane_id,
                    turn_id=turn_id,
                    artifact_id=str(chunk.get("artifact_id") or ""),
                    sequence_number=int(chunk.get("sequence_number") or 0),
                    first_sample=int(chunk.get("first_sample") or 0),
                    pcm_base64=base64.b64encode(pcm).decode("ascii"),
                )
            )

        try:
            tts_payload = await asyncio.to_thread(
                self.bridge.synthesize,
                session_id=runtime.session_id,
                text=text,
                language=lane.target_language,
                fairness_key=runtime.tts_fairness_key,
                settings=runtime.tts_settings,
                reference_wav_path=reference_wav_path,
                reference_prompt_text=reference_prompt_text,
                source_audio_duration_ms=source_audio_duration_ms,
                on_stream_started=stream_started,
                on_audio_chunk=audio_chunk,
                cancellation=cancellation,
            )
        except asyncio.CancelledError:
            cancellation.cancel()
            self.active_stream_artifacts.pop(stream_artifact_id, None)
            raise
        except _StaleTtsStream:
            cancellation.cancel()
            self.active_stream_artifacts.pop(stream_artifact_id, None)
            return
        except TtsReferenceUnavailableError as exc:
            LOGGER.warning(
                "tts skipped (reference unavailable) lane=%s turn=%s lang=%s: %s",
                lane.lane_id,
                turn_id,
                lane.target_language,
                exc,
            )
            if self._turn_is_speaking(turn_id):
                self._set_part_speech_state(
                    speaking_part_ids,
                    expected="speaking",
                    replacement="spoken",
                )
                runtime._refresh_turn_state()
                await runtime._send_turn_update(reason="tts_skipped")
            return
        except Exception as exc:
            self.active_stream_artifacts.pop(stream_artifact_id, None)
            if self._turn_is_speaking(turn_id):
                if stream_artifact_id:
                    await runtime.lifecycle.send(
                        event(
                            "tts_stream_failed",
                            runtime.session_id,
                            lane_id=lane.lane_id,
                            turn_id=turn_id,
                            artifact_id=stream_artifact_id,
                        )
                    )
                self._set_part_speech_state(
                    speaking_part_ids,
                    expected="speaking",
                    replacement="pending",
                )
                runtime._refresh_turn_state()
                await runtime._send_turn_update(reason="tts_failed")
            await runtime.lifecycle.send(
                event(
                    "error",
                    runtime.session_id,
                    code="tts_failed",
                    message=str(exc),
                    lane_id=lane.lane_id,
                    turn_id=turn_id,
                )
            )
            return
        finally:
            if lane.tts_task is current_task:
                lane.tts_task = None

        if not self._turn_is_speaking(turn_id):
            return
        artifact_id = str(tts_payload.get("artifact_id") or "").strip()
        self.active_stream_artifacts.pop(artifact_id, None)
        if artifact_id:
            lane.pending_tts[artifact_id] = {
                "turn_id": turn_id,
                "artifact_id": artifact_id,
                "text": text,
                "part_ids": list(speaking_part_ids),
                "tts": dict(tts_payload),
            }
            for part_id in speaking_part_ids:
                self.cached_turn_artifacts[(turn_id, part_id)] = dict(tts_payload)
        await runtime.lifecycle.send(
            event(
                "tts_stream_complete",
                runtime.session_id,
                lane_id=lane.lane_id,
                turn_id=turn_id,
                tts=tts_payload,
            )
        )

    async def stop(self, payload: dict[str, Any]) -> None:
        runtime = self.runtime
        turn = runtime.current_turn
        lane_id = str(payload.get("lane_id") or "").strip()
        turn_id = str(payload.get("turn_id") or "").strip()
        artifact_id = str(payload.get("artifact_id") or "").strip()
        if lane_id != turn.lane_id or turn_id != turn.turn_id:
            return
        lane = runtime.lanes[lane_id]
        current_pending = lane.pending_tts.get(artifact_id) or {}
        current_part_ids = {
            str(part_id) for part_id in current_pending.get("part_ids", [])
        }
        active_artifact_ids = [
            active_id
            for active_id, (active_turn_id, _part_ids) in self.active_stream_artifacts.items()
            if active_turn_id == turn_id
        ]

        self.stream_generation += 1
        task = lane.tts_task
        lane.tts_task = None
        await cancel_task(task)

        for active_id in active_artifact_ids:
            self.active_stream_artifacts.pop(active_id, None)
            await runtime.lifecycle.send(
                event(
                    "tts_stream_failed",
                    runtime.session_id,
                    lane_id=lane_id,
                    turn_id=turn_id,
                    artifact_id=active_id,
                )
            )

        lane.pending_tts.clear()
        for part in turn.parts:
            if part.speech_state != "speaking":
                continue
            cache_key = (turn_id, part.part_id)
            if part.part_id in current_part_ids and cache_key in self.cached_turn_artifacts:
                part.speech_state = "spoken"
            else:
                part.speech_state = "pending"
                self.cached_turn_artifacts.pop(cache_key, None)
        runtime._refresh_turn_state()
        await runtime._send_turn_update(reason="tts_stopped")

    async def playback_complete(self, payload: dict[str, Any]) -> None:
        runtime = self.runtime
        lane_id = str(payload.get("lane_id") or "").strip()
        turn_id = str(payload.get("turn_id") or "").strip()
        artifact_id = str(payload.get("artifact_id") or "").strip()
        lane = runtime.lanes.get(lane_id)
        if lane is None or turn_id != runtime.current_turn.turn_id or not artifact_id:
            return
        pending = lane.pending_tts.pop(artifact_id, None)
        if pending is None or turn_id != str(pending.get("turn_id") or ""):
            return
        self._set_part_speech_state(
            [str(part_id) for part_id in pending.get("part_ids", [])],
            expected="speaking",
            replacement="spoken",
        )
        runtime._refresh_turn_state()
        await runtime._send_turn_update(reason="tts_playback_complete")

    def discard_turn(self, turn_id: str) -> None:
        stable_turn_id = str(turn_id or "").strip()
        if not stable_turn_id:
            return
        self.stream_generation += 1
        for cache_key in [key for key in self.cached_turn_artifacts if key[0] == stable_turn_id]:
            self.cached_turn_artifacts.pop(cache_key, None)
        for artifact_id, (active_turn_id, _part_ids) in list(self.active_stream_artifacts.items()):
            if active_turn_id == stable_turn_id:
                self.active_stream_artifacts.pop(artifact_id, None)

    def clear(self) -> None:
        self.stream_generation += 1
        self.cached_turn_artifacts.clear()
        self.active_stream_artifacts.clear()

    def record_asr_reference(self, lane: ConversationLane) -> None:
        """Keep the latest ASR WAV that is suitable as a voice reference."""
        wav_path = str(lane.last_asr_wav_path or "").strip()
        if not wav_path:
            return
        if _last_speech_quality_score(lane.last_asr_segments, wav_path) >= LAST_SPEECH_QUALITY_THRESHOLD:
            lane.last_qualifying_asr_wav_path = wav_path

    def _set_part_reference_quality(
        self,
        speaking_part_ids: list[str],
        *,
        low_quality: bool,
    ) -> None:
        selection = set(speaking_part_ids)
        for part in self.runtime.current_turn.parts:
            if part.part_id in selection:
                part.low_quality_reference = low_quality

    def _turn_is_speaking(self, turn_id: str) -> bool:
        turn = self.runtime.current_turn
        return turn.turn_id == turn_id and getattr(turn.state, "value", "") == "open_speaking"

    def _set_part_speech_state(
        self,
        part_ids: list[str],
        *,
        expected: str,
        replacement: str,
    ) -> None:
        selection = set(part_ids)
        for part in self.runtime.current_turn.parts:
            if part.part_id in selection and part.speech_state == expected:
                part.speech_state = replacement


def _wav_duration_ms(path: str) -> int:
    try:
        import wave

        with wave.open(path, "rb") as wav_file:
            frames = wav_file.getnframes()
            rate = wav_file.getframerate()
            if rate <= 0:
                return 0
            return int((frames / rate) * 1000)
    except Exception:
        return 0


def _last_speech_quality_score(segments: list[dict[str, Any]], wav_path: str) -> float:
    if not wav_path:
        return 0.0
    duration_ms = _wav_duration_ms(wav_path)
    if duration_ms <= 0 or not segments:
        return 0.0
    speech_ms = 0
    sorted_segments = sorted(
        (
            (int(max(0, segment.get("t0_ms") or 0)), int(max(0, segment.get("t1_ms") or 0)))
            for segment in segments
        ),
        key=lambda pair: pair[0],
    )
    max_gap_ms = 0
    previous_end = None
    for start_ms, end_ms in sorted_segments:
        if end_ms > start_ms:
            speech_ms += end_ms - start_ms
        if previous_end is not None:
            max_gap_ms = max(max_gap_ms, start_ms - previous_end)
        previous_end = end_ms
    duration_s = duration_ms / 1000.0
    coverage = min(1.0, speech_ms / duration_ms)
    silence_penalty = max(0.0, 1.0 - (max_gap_ms / 1000.0))
    return min(min(1.0, duration_s / 3.0), coverage, silence_penalty)


def _last_speech_prompt_text(
    lane: ConversationLane,
    reference_wav_path: str | None,
) -> str | None:
    if not reference_wav_path:
        return None
    current = (lane.last_asr_wav_path or "").strip()
    if not current or current != reference_wav_path:
        return None
    parts = []
    for segment in lane.last_asr_segments or []:
        if not isinstance(segment, dict):
            continue
        text = str(segment.get("text") or "").strip()
        if text:
            parts.append(text)
    joined = " ".join(parts).strip()
    return joined or None


def _source_bubble_duration_ms(lane: ConversationLane) -> int | None:
    path = (lane.last_asr_wav_path or "").strip()
    if not path or not Path(path).is_file():
        return None
    return _wav_duration_ms(path)


def _last_speech_reference_choice(
    lane: ConversationLane,
    tts_settings: dict[str, Any],
) -> tuple[str | None, bool]:
    """Prefer a qualifying latest fragment, then a qualifying holdover."""
    if not tts_uses_asr_reference_wav(lane.target_language, settings=tts_settings):
        return None, False
    current = (lane.last_asr_wav_path or "").strip()
    qualifying = (lane.last_qualifying_asr_wav_path or "").strip()
    if current and Path(current).is_file():
        score = _last_speech_quality_score(lane.last_asr_segments, current)
        if score >= LAST_SPEECH_QUALITY_THRESHOLD:
            return current, False
    if qualifying and Path(qualifying).is_file():
        return qualifying, False
    if current and Path(current).is_file():
        return current, True
    return None, False
