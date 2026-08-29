"""TTS streaming, cached replay, and playback settlement."""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import json
import logging
import time
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from app.config import get_int
from app.live_metrics import log_event as _metric
from app.protocol import event
from app.tts_bridge import TtsReferenceUnavailableError
from app.tts_bridge import get_tts_bridge
from app.tts_bridge import product_stable_voice_settings
from app.tts_bridge import product_voice_cloning_settings
from app.tts_bridge import tts_settings_enabled
from app.tts_bridge import tts_supports_product_voice_modes
from app.tts_bridge import tts_uses_asr_reference_wav
from app.upstreams.tts_pool.client import TtsSynthesisCancellation
from app.voice.mode import VOICE_MODE_FEMALE
from app.voice.mode import VOICE_MODE_MALE
from app.voice.mode import VOICE_MODE_SPEAKER_CLONE
from app.voice.session_storage import SessionArtifactLimitExceeded
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


@dataclass
class _Preparation:
    lane_id: str
    turn_id: str
    part_id: str
    text: str
    target_language: str
    settings: dict[str, Any]
    settings_key: str
    voice_mode: str
    synthesis_voice_mode: str
    reason: str
    reference_wav_path: str | None
    reference_prompt_text: str | None
    source_audio_duration_ms: int | None
    low_quality_reference: bool
    reference_id: str | None = None
    state: str = "queued"
    subscribed: bool = False
    used: bool = False
    playback_kind: str = "first"
    playback_trigger: str = "explicit"
    started_tts: dict[str, Any] | None = None
    chunks: list[dict[str, Any]] = field(default_factory=list)
    forward_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    forwarded_chunks: int = 0
    started_sent: bool = False
    artifact_id: str = ""
    tts_payload: dict[str, Any] | None = None
    cancellation: TtsSynthesisCancellation | None = None
    done: asyncio.Future[None] | None = None
    cancelled: bool = False
    created_mono: float = field(default_factory=time.monotonic)
    subscribed_mono: float | None = None
    first_pcm_seen: bool = False

    @property
    def key(self) -> tuple[str, str]:
        return self.turn_id, self.part_id


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
        self.preparations: dict[tuple[str, str], _Preparation] = {}
        self.generation_queue: list[tuple[str, str]] = []
        self.generation_task: asyncio.Task[Any] | None = None
        self.active_preparation_key: tuple[str, str] | None = None
        self.active_stream_artifacts: dict[str, tuple[str, list[str]]] = {}
        self.speculation_limit = get_int(
            "live.tts_delivery.speculative_bubble_limit",
            8,
            min_value=0,
        )
        self.speculation_budget = self.speculation_limit
        self.speculation_exhaustion_reported = False

    @property
    def auto_speak_enabled(self) -> bool:
        return tts_settings_enabled(self.runtime.tts_settings) and bool(
            self.runtime.tts_settings.get("auto_speak")
        )

    def prepare_definitive_part(
        self,
        *,
        lane_id: str,
        turn_id: str,
        part_id: str,
    ) -> bool:
        runtime = self.runtime
        if self.auto_speak_enabled or not tts_settings_enabled(runtime.tts_settings):
            return False
        if self.speculation_budget <= 0:
            if not self.speculation_exhaustion_reported:
                self.speculation_exhaustion_reported = True
                _metric(
                    "tts_speculation_budget",
                    sess=runtime.session_id,
                    action="exhausted",
                    remaining=0,
                )
            return False
        part = self._current_part(turn_id, part_id)
        if part is None or not part.is_closed or not self.part_target_text(part):
            return False
        key = (turn_id, part_id)
        existing = self.preparations.get(key)
        if existing is not None and self._record_is_current(existing):
            return False
        if existing is not None:
            self._drop_record(existing)
        record = self._new_preparation(
            lane_id=lane_id,
            turn_id=turn_id,
            part_id=part_id,
            reason="speculative",
        )
        if record is None:
            return False
        self.speculation_budget -= 1
        self._enqueue(record)
        _metric(
            "tts_speculation_budget",
            sess=runtime.session_id,
            action="consume",
            remaining=self.speculation_budget,
        )
        return True

    def reset_speculation_budget(self, *, reason: str) -> None:
        self.speculation_budget = self.speculation_limit
        self.speculation_exhaustion_reported = False
        _metric(
            "tts_speculation_budget",
            sess=self.runtime.session_id,
            action="reset",
            reason=str(reason or "playback_intent"),
            remaining=self.speculation_budget,
        )

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
        self.reset_speculation_budget(reason="replay_tts")
        text = self.part_target_text(part)
        record = self.preparations.get((turn.turn_id, part_id))
        if (
            not text
            or record is None
            or record.state != "ready"
            or record.tts_payload is None
            or not self._record_is_current(record)
        ):
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
        await self._deliver_ready_artifact(
            record,
            playback_kind="replay",
            playback_trigger="explicit",
        )

    async def run_speak_sequence(
        self,
        lane_id: str,
        turn_id: str,
        part_ids: list[str],
        *,
        generation_reason: str = "demand",
    ) -> None:
        """Subscribe selected bubbles in order while playback overlaps generation."""
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
                await self._play_part(
                    lane_id=lane.lane_id,
                    turn_id=turn_id,
                    part_id=part_id,
                    generation_reason=generation_reason,
                )
        finally:
            if lane.tts_task is current_task:
                lane.tts_task = None

    async def _play_part(
        self,
        *,
        lane_id: str,
        turn_id: str,
        part_id: str,
        generation_reason: str,
    ) -> None:
        if not tts_settings_enabled(self.runtime.tts_settings):
            return
        playback_trigger = "automatic" if generation_reason == "automatic" else "explicit"
        key = (turn_id, part_id)
        record = self.preparations.get(key)
        if record is not None and not self._record_is_current(record):
            self._drop_record(record)
            record = None
        if record is None or record.state in {"failed", "cancelled"}:
            if record is not None:
                self._drop_record(record)
            record = self._new_preparation(
                lane_id=lane_id,
                turn_id=turn_id,
                part_id=part_id,
                reason=generation_reason,
            )
            if record is None:
                part = self._current_part(turn_id, part_id)
                if part is not None and part.speech_state == "speaking":
                    part.speech_state = "pending"
                    self.runtime._refresh_turn_state()
                    await self.runtime._send_turn_update(reason="tts_preparation_unavailable")
                return
            self._record_playback_path(record, "demand_miss")
            await self._prioritize_explicit(record)
            await self._subscribe(record, playback_trigger=playback_trigger)
            self._enqueue(record, priority=True)
        elif record.state == "ready":
            self._record_playback_path(record, "ready_hit")
            await self._subscribe(record, playback_trigger=playback_trigger)
            await self._deliver_ready_artifact(
                record,
                playback_kind="first",
                playback_trigger=playback_trigger,
            )
            return
        else:
            self._record_playback_path(record, "joined_generation")
            await self._subscribe(record, playback_trigger=playback_trigger)
            if record.state == "queued":
                self._move_to_front(record.key)
            await self._cancel_unrelated_speculation(record.key)
        if record.done is not None:
            await asyncio.shield(record.done)

    def _new_preparation(
        self,
        *,
        lane_id: str,
        turn_id: str,
        part_id: str,
        reason: str,
    ) -> _Preparation | None:
        runtime = self.runtime
        if not tts_settings_enabled(runtime.tts_settings):
            return None
        lane = runtime.lanes.get(lane_id)
        part = self._current_part(turn_id, part_id)
        if lane is None or part is None:
            return None
        text = self.part_target_text(part)
        if not text:
            return None
        settings = deepcopy(runtime.tts_settings)
        voice_mode = str(runtime.voice_mode or VOICE_MODE_FEMALE)
        synthesis_voice_mode = voice_mode
        reference_id = None
        reference = (
            runtime.voice_cloning.reference(lane_id)
            if voice_mode == VOICE_MODE_SPEAKER_CLONE
            else None
        )
        if voice_mode == VOICE_MODE_SPEAKER_CLONE and reference is not None:
            try:
                settings = product_voice_cloning_settings(
                    settings,
                    language=lane.target_language,
                    max_duration_s=runtime.voice_cloning.max_duration_ms / 1000.0,
                )
            except ValueError:
                _metric(
                    "voice_cloning_tts_skip",
                    sess=runtime.session_id,
                    lane=lane_id,
                    trigger=reason,
                    cause="unsupported_target_language",
                )
                return None
            reference_id = reference.reference_id
            reference_wav_path = reference.wav_path
            reference_prompt_text = reference.prompt_text
            source_audio_duration_ms = reference.duration_ms
            low_quality = False
        else:
            if voice_mode == VOICE_MODE_SPEAKER_CLONE:
                synthesis_voice_mode = str(
                    getattr(runtime, "voice_clone_fallback_mode", VOICE_MODE_FEMALE)
                )
                _metric(
                    "voice_cloning_tts_fallback",
                    sess=runtime.session_id,
                    lane=lane_id,
                    trigger=reason,
                    mode=synthesis_voice_mode,
                )
            if (
                synthesis_voice_mode in {VOICE_MODE_FEMALE, VOICE_MODE_MALE}
                and tts_supports_product_voice_modes(settings)
            ):
                try:
                    settings = product_stable_voice_settings(
                        settings,
                        language=lane.target_language,
                        gender=synthesis_voice_mode,
                    )
                except ValueError:
                    _metric(
                        "product_voice_tts_skip",
                        sess=runtime.session_id,
                        lane=lane_id,
                        trigger=reason,
                        mode=synthesis_voice_mode,
                        cause="unsupported_target_language",
                    )
                    return None
            reference_wav_path, low_quality = _last_speech_reference_choice(lane, settings)
            reference_prompt_text = _last_speech_prompt_text(lane, reference_wav_path)
            source_audio_duration_ms = _source_bubble_duration_ms(lane)
            if reference_wav_path is not None or tts_uses_asr_reference_wav(
                lane.target_language,
                settings=settings,
            ):
                self._set_part_reference_quality([part_id], low_quality=low_quality)
        return _Preparation(
            lane_id=lane_id,
            turn_id=turn_id,
            part_id=part_id,
            text=text,
            target_language=lane.target_language,
            settings=settings,
            settings_key=_synthesis_settings_key(
                runtime.tts_settings,
                voice_mode=voice_mode,
                synthesis_voice_mode=synthesis_voice_mode,
                reference_id=reference_id,
            ),
            voice_mode=voice_mode,
            synthesis_voice_mode=synthesis_voice_mode,
            reason=str(reason or "demand"),
            reference_wav_path=reference_wav_path,
            reference_prompt_text=reference_prompt_text,
            source_audio_duration_ms=source_audio_duration_ms,
            low_quality_reference=low_quality,
            reference_id=reference_id,
            done=asyncio.get_running_loop().create_future(),
        )

    def _enqueue(self, record: _Preparation, *, priority: bool = False) -> None:
        self.preparations[record.key] = record
        if priority:
            self.generation_queue.insert(0, record.key)
        else:
            self.generation_queue.append(record.key)
        self._ensure_worker()

    def _ensure_worker(self) -> None:
        if self.generation_task is None or self.generation_task.done():
            self.generation_task = asyncio.create_task(self._run_generation_queue())

    async def _run_generation_queue(self) -> None:
        current_task = asyncio.current_task()
        try:
            while self.generation_queue:
                key = self.generation_queue.pop(0)
                record = self.preparations.get(key)
                if record is None or record.state != "queued" or record.cancelled:
                    continue
                self.active_preparation_key = key
                try:
                    await self._generate(record)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    await self._settle_unexpected_generation_failure(record, exc)
                finally:
                    self.active_preparation_key = None
        finally:
            self.active_preparation_key = None
            if self.generation_task is current_task:
                self.generation_task = None

    async def _generate(self, record: _Preparation) -> None:
        try:
            await self._generate_record(record)
        finally:
            self._resolve_done(record)

    async def _generate_record(self, record: _Preparation) -> None:
        runtime = self.runtime
        lane = runtime.lanes[record.lane_id]
        loop = asyncio.get_running_loop()
        cancellation = TtsSynthesisCancellation()
        record.cancellation = cancellation
        record.state = "generating"
        _metric(
            "tts_preparation",
            sess=runtime.session_id,
            lane=record.lane_id,
            part=record.part_id,
            reason=record.reason,
            state="started",
            queue_ms=round((time.monotonic() - record.created_mono) * 1000.0, 2),
        )

        async def deliver_from_synthesis(kind: str, payload: dict[str, Any]) -> None:
            if not self._record_is_current(record):
                raise _StaleTtsStream()
            if kind == "started":
                record.started_tts = dict(payload)
                record.artifact_id = str(payload.get("artifact_id") or "").strip()
                if record.artifact_id:
                    self.active_stream_artifacts[record.artifact_id] = (
                        record.turn_id,
                        [record.part_id],
                    )
                if record.subscribed:
                    await self._send_started(record)
                return
            pcm = bytes(payload.get("pcm") or b"")
            if not pcm:
                return
            if not record.first_pcm_seen:
                record.first_pcm_seen = True
                fields: dict[str, Any] = {
                    "sess": runtime.session_id,
                    "lane": record.lane_id,
                    "part": record.part_id,
                    "reason": record.reason,
                    "preparation_ms": round(
                        (time.monotonic() - record.created_mono) * 1000.0,
                        2,
                    ),
                }
                if record.subscribed_mono is not None:
                    fields["subscription_ms"] = round(
                        (time.monotonic() - record.subscribed_mono) * 1000.0,
                        2,
                    )
                _metric("tts_first_pcm", **fields)
            record.chunks.append(
                {
                    "artifact_id": str(payload.get("artifact_id") or ""),
                    "sequence_number": int(payload.get("sequence_number") or 0),
                    "first_sample": int(payload.get("first_sample") or 0),
                    "pcm_base64": base64.b64encode(pcm).decode("ascii"),
                }
            )
            if record.subscribed:
                await self._forward_buffered_chunks(record)

        def send_from_synthesis(kind: str, payload: dict[str, Any]) -> None:
            future = asyncio.run_coroutine_threadsafe(
                deliver_from_synthesis(kind, payload),
                loop,
            )
            try:
                future.result(timeout=STREAM_SEND_TIMEOUT_S)
            except concurrent.futures.TimeoutError:
                future.cancel()
                raise

        def stream_started(tts: dict[str, Any]) -> None:
            send_from_synthesis("started", tts)

        def audio_chunk(chunk: dict[str, Any]) -> None:
            send_from_synthesis("chunk", chunk)

        try:
            tts_payload = await asyncio.to_thread(
                self.bridge.synthesize,
                session_id=runtime.session_id,
                text=record.text,
                language=record.target_language,
                fairness_key=runtime.tts_fairness_key,
                settings=record.settings,
                reference_wav_path=record.reference_wav_path,
                reference_prompt_text=record.reference_prompt_text,
                source_audio_duration_ms=record.source_audio_duration_ms,
                on_stream_started=stream_started,
                on_audio_chunk=audio_chunk,
                cancellation=cancellation,
            )
        except asyncio.CancelledError:
            cancellation.cancel()
            self.active_stream_artifacts.pop(record.artifact_id, None)
            record.state = "cancelled"
            self._resolve_done(record)
            raise
        except _StaleTtsStream:
            cancellation.cancel()
            self.active_stream_artifacts.pop(record.artifact_id, None)
            record.state = "cancelled"
            self._resolve_done(record)
            return
        except TtsReferenceUnavailableError as exc:
            LOGGER.warning(
                "tts skipped (reference unavailable) lane=%s turn=%s lang=%s: %s",
                lane.lane_id,
                record.turn_id,
                record.target_language,
                exc,
            )
            record.state = "failed"
            if record.subscribed and self._turn_is_current(record.turn_id):
                self._set_part_speech_state(
                    [record.part_id],
                    expected="speaking",
                    replacement="spoken",
                )
                runtime._refresh_turn_state()
                await runtime._send_turn_update(reason="tts_skipped")
            self._resolve_done(record)
            return
        except SessionArtifactLimitExceeded as exc:
            self.active_stream_artifacts.pop(record.artifact_id, None)
            record.state = "failed"
            record.chunks.clear()
            self._resolve_done(record)
            await runtime.lifecycle.end_for_storage_limit(limit_bytes=exc.limit_bytes)
            return
        except Exception as exc:
            self.active_stream_artifacts.pop(record.artifact_id, None)
            record.state = "cancelled" if record.cancelled else "failed"
            if record.cancelled:
                self._resolve_done(record)
                return
            if record.subscribed and self._turn_is_current(record.turn_id):
                await self._send_stream_failed(record)
                self._set_part_speech_state(
                    [record.part_id],
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
                        turn_id=record.turn_id,
                    )
                )
            _metric(
                "tts_preparation",
                sess=runtime.session_id,
                lane=record.lane_id,
                part=record.part_id,
                reason=record.reason,
                state="failed",
            )
            self._resolve_done(record)
            return

        if not self._record_is_current(record):
            record.state = "cancelled"
            self._resolve_done(record)
            return
        artifact_id = str(tts_payload.get("artifact_id") or "").strip()
        self.active_stream_artifacts.pop(artifact_id, None)
        record.artifact_id = artifact_id
        record.tts_payload = dict(tts_payload)
        record.state = "ready"
        if artifact_id and record.subscribed:
            lane.pending_tts[artifact_id] = {
                "turn_id": record.turn_id,
                "artifact_id": artifact_id,
                "text": record.text,
                "part_ids": [record.part_id],
                "tts": dict(tts_payload),
            }
        if record.subscribed:
            await runtime.lifecycle.send(
                event(
                    "tts_stream_complete",
                    runtime.session_id,
                    lane_id=lane.lane_id,
                    turn_id=record.turn_id,
                    tts=tts_payload,
                )
            )
        record.chunks.clear()
        record.forwarded_chunks = 0
        _metric(
            "tts_preparation",
            sess=runtime.session_id,
            lane=record.lane_id,
            part=record.part_id,
            reason=record.reason,
            state="ready",
        )
        self._resolve_done(record)

    async def _subscribe(
        self,
        record: _Preparation,
        *,
        playback_trigger: str,
    ) -> None:
        record.playback_trigger = playback_trigger
        if not record.subscribed:
            record.subscribed = True
            record.subscribed_mono = time.monotonic()
            record.playback_kind = "first"
            if not record.used:
                record.used = True
                _metric(
                    "tts_prepared_artifact",
                    sess=self.runtime.session_id,
                    lane=record.lane_id,
                    part=record.part_id,
                    action="used",
                    reason=record.reason,
                )
        if record.state == "generating":
            await self._forward_buffered_chunks(record)

    async def _send_started(self, record: _Preparation) -> None:
        if record.started_sent or record.started_tts is None:
            return
        record.started_sent = True
        await self.runtime.lifecycle.send(
            event(
                "tts_stream_started",
                self.runtime.session_id,
                lane_id=record.lane_id,
                turn_id=record.turn_id,
                part_ids=[record.part_id],
                playback_kind=record.playback_kind,
                playback_trigger=record.playback_trigger,
                tts=dict(record.started_tts),
            )
        )

    async def _forward_buffered_chunks(self, record: _Preparation) -> None:
        async with record.forward_lock:
            await self._send_started(record)
            chunks = record.chunks
            record.chunks = []
            for chunk in chunks:
                await self.runtime.lifecycle.send(
                    event(
                        "tts_stream_chunk",
                        self.runtime.session_id,
                        lane_id=record.lane_id,
                        turn_id=record.turn_id,
                        **chunk,
                    )
                )
                record.forwarded_chunks += 1

    async def _deliver_ready_artifact(
        self,
        record: _Preparation,
        *,
        playback_kind: str,
        playback_trigger: str,
    ) -> None:
        if record.tts_payload is None or not self._record_is_current(record):
            return
        record.used = True
        if playback_kind == "first":
            lane = self.runtime.lanes[record.lane_id]
            lane.pending_tts[record.artifact_id] = {
                "turn_id": record.turn_id,
                "artifact_id": record.artifact_id,
                "text": record.text,
                "part_ids": [record.part_id],
                "tts": dict(record.tts_payload),
            }
        await self.runtime.lifecycle.send(
            event(
                "tts_artifact_ready",
                self.runtime.session_id,
                lane_id=record.lane_id,
                turn_id=record.turn_id,
                part_id=record.part_id,
                part_ids=[record.part_id],
                text=record.text,
                playback_kind=playback_kind,
                playback_trigger=playback_trigger,
                tts=dict(record.tts_payload),
            )
        )

    async def _prioritize_explicit(self, record: _Preparation) -> None:
        await self._cancel_unrelated_speculation(record.key)

    async def _cancel_unrelated_speculation(
        self,
        keep_key: tuple[str, str],
    ) -> None:
        active = self.preparations.get(self.active_preparation_key or ("", ""))
        if (
            active is None
            or active.key == keep_key
            or active.reason != "speculative"
            or active.subscribed
        ):
            return
        self._drop_record(active)

    def _move_to_front(self, key: tuple[str, str]) -> None:
        self.generation_queue = [queued for queued in self.generation_queue if queued != key]
        self.generation_queue.insert(0, key)
        self._ensure_worker()

    async def settings_changed(
        self,
        previous: dict[str, Any],
        current: dict[str, Any],
    ) -> None:
        synthesis_changed = _synthesis_settings_key(previous) != _synthesis_settings_key(current)
        auto_disabled = bool(previous.get("auto_speak")) and not bool(current.get("auto_speak"))
        changed_parts = False
        for record in list(self.preparations.values()):
            cancel_for_auto = (
                auto_disabled
                and record.reason == "automatic"
                and record.state in {"queued", "generating"}
                and record.forwarded_chunks == 0
            )
            if not synthesis_changed and not cancel_for_auto:
                continue
            pending = self.runtime.lanes[record.lane_id].pending_tts
            if record.state == "ready" and record.artifact_id in pending:
                self.preparations.pop(record.key, None)
                continue
            if record.subscribed and record.state in {"queued", "generating"}:
                await self._send_stream_failed(record)
                self._set_part_speech_state(
                    [record.part_id],
                    expected="speaking",
                    replacement="pending",
                )
                changed_parts = True
            self._drop_record(record)
        if changed_parts:
            self.runtime._refresh_turn_state()
            await self.runtime._send_turn_update(reason="tts_settings_changed")

    def voice_mode_changed(self, *, mode: str) -> None:
        """Drop unused preparations made under a different product voice mode."""
        for record in list(self.preparations.values()):
            if record.subscribed or record.voice_mode == mode:
                continue
            self._drop_record(record)

    def voice_cloning_reference_ready(self, *, lane_id: str) -> None:
        """Drop unused product-voice fallbacks once the speaker voice is ready."""
        for record in list(self.preparations.values()):
            if (
                record.lane_id != lane_id
                or record.voice_mode != VOICE_MODE_SPEAKER_CLONE
                or record.synthesis_voice_mode not in {VOICE_MODE_FEMALE, VOICE_MODE_MALE}
                or record.subscribed
            ):
                continue
            self._drop_record(record)

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
        task = lane.tts_task
        lane.tts_task = None
        await cancel_task(task)

        for record in list(self.preparations.values()):
            if record.turn_id != turn_id or not record.subscribed:
                continue
            if record.state in {"queued", "generating"}:
                await self._send_stream_failed(record)
                self._drop_record(record)
            else:
                record.subscribed = False

        lane.pending_tts.clear()
        for part in turn.parts:
            if part.speech_state != "speaking":
                continue
            cache_key = (turn_id, part.part_id)
            record = self.preparations.get(cache_key)
            if (
                part.part_id in current_part_ids
                and record is not None
                and record.state == "ready"
            ):
                part.speech_state = "spoken"
            else:
                part.speech_state = "pending"
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
        for record in list(self.preparations.values()):
            if record.turn_id == stable_turn_id:
                self._drop_record(record)
        for artifact_id, (active_turn_id, _part_ids) in list(self.active_stream_artifacts.items()):
            if active_turn_id == stable_turn_id:
                self.active_stream_artifacts.pop(artifact_id, None)

    def clear(self) -> None:
        for record in list(self.preparations.values()):
            self._drop_record(record)
        self.generation_queue.clear()
        if self.generation_task is not None:
            self.generation_task.cancel()
        self.generation_task = None
        self.active_preparation_key = None
        self.active_stream_artifacts.clear()

    def _drop_record(self, record: _Preparation) -> None:
        previous_state = record.state
        was_cancelled = record.cancelled
        record.cancelled = True
        if record.cancellation is not None:
            record.cancellation.cancel()
        self.generation_queue = [key for key in self.generation_queue if key != record.key]
        if self.preparations.get(record.key) is record:
            self.preparations.pop(record.key, None)
        if record.artifact_id:
            self.active_stream_artifacts.pop(record.artifact_id, None)
        if previous_state in {"queued", "generating"}:
            record.state = "cancelled"
            self._resolve_done(record)
        if record.state == "ready" and not record.used:
            _metric(
                "tts_prepared_artifact",
                sess=self.runtime.session_id,
                lane=record.lane_id,
                part=record.part_id,
                action="unused",
                reason=record.reason,
            )
        if not was_cancelled and previous_state in {"queued", "generating"}:
            _metric(
                "tts_preparation",
                sess=self.runtime.session_id,
                lane=record.lane_id,
                part=record.part_id,
                reason=record.reason,
                state="cancelled",
            )

    async def _send_stream_failed(self, record: _Preparation) -> None:
        if not record.started_sent or not record.artifact_id:
            return
        await self.runtime.lifecycle.send(
            event(
                "tts_stream_failed",
                self.runtime.session_id,
                lane_id=record.lane_id,
                turn_id=record.turn_id,
                artifact_id=record.artifact_id,
            )
        )

    async def _settle_unexpected_generation_failure(
        self,
        record: _Preparation,
        exc: Exception,
    ) -> None:
        LOGGER.exception(
            "tts preparation failed outside the synthesis error path lane=%s turn=%s part=%s",
            record.lane_id,
            record.turn_id,
            record.part_id,
            exc_info=exc,
        )
        if record.cancellation is not None:
            record.cancellation.cancel()
        self.active_stream_artifacts.pop(record.artifact_id, None)
        lane = self.runtime.lanes[record.lane_id]
        lane.pending_tts.pop(record.artifact_id, None)
        record.state = "cancelled" if record.cancelled else "failed"
        record.chunks.clear()
        record.forwarded_chunks = 0
        if record.subscribed and self._turn_is_current(record.turn_id):
            self._set_part_speech_state(
                [record.part_id],
                expected="speaking",
                replacement="pending",
            )
            self.runtime._refresh_turn_state()
            try:
                await self._send_stream_failed(record)
            except Exception:
                LOGGER.warning(
                    "could not report failed TTS stream lane=%s turn=%s part=%s",
                    record.lane_id,
                    record.turn_id,
                    record.part_id,
                    exc_info=True,
                )
            try:
                await self.runtime._send_turn_update(reason="tts_failed")
            except Exception:
                LOGGER.warning(
                    "could not report TTS turn recovery lane=%s turn=%s part=%s",
                    record.lane_id,
                    record.turn_id,
                    record.part_id,
                    exc_info=True,
                )
        _metric(
            "tts_preparation",
            sess=self.runtime.session_id,
            lane=record.lane_id,
            part=record.part_id,
            reason=record.reason,
            state="failed",
        )

    def _record_is_current(self, record: _Preparation) -> bool:
        if (
            record.cancelled
            or self.runtime.lifecycle.closed
            or self.preparations.get(record.key) is not record
            or not tts_settings_enabled(self.runtime.tts_settings)
            or record.settings_key != _synthesis_settings_key(
                self.runtime.tts_settings,
                # A subscribed preparation keeps the voice mode and immutable
                # reference it started with. New choices apply to later work.
                voice_mode=record.voice_mode,
                synthesis_voice_mode=record.synthesis_voice_mode,
                reference_id=record.reference_id,
            )
        ):
            return False
        part = self._current_part(record.turn_id, record.part_id)
        return (
            part is not None
            and self.part_target_text(part) == record.text
            and self.runtime.lanes[record.lane_id].target_language == record.target_language
        )

    def _current_part(self, turn_id: str, part_id: str) -> TurnPart | None:
        if not self._turn_is_current(turn_id):
            return None
        return next(
            (part for part in self.runtime.current_turn.parts if part.part_id == part_id),
            None,
        )

    def _turn_is_current(self, turn_id: str) -> bool:
        return self.runtime.current_turn.turn_id == turn_id

    @staticmethod
    def _resolve_done(record: _Preparation) -> None:
        if record.done is not None and not record.done.done():
            record.done.set_result(None)

    def _record_playback_path(self, record: _Preparation, path: str) -> None:
        _metric(
            "tts_playback_path",
            sess=self.runtime.session_id,
            lane=record.lane_id,
            part=record.part_id,
            reason=record.reason,
            path=path,
        )

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


def _synthesis_settings_key(
    settings: dict[str, Any] | None,
    *,
    voice_mode: str | None = None,
    synthesis_voice_mode: str | None = None,
    reference_id: str | None = None,
) -> str:
    payload = deepcopy(settings or {})
    payload.pop("auto_speak", None)
    if voice_mode:
        payload["product_voice_mode"] = voice_mode
    if synthesis_voice_mode:
        payload["product_synthesis_voice_mode"] = synthesis_voice_mode
    if reference_id:
        payload["voice_cloning_reference_id"] = reference_id
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


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
