from __future__ import annotations

import asyncio
import contextlib
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket, status
from realtime_asr_engine import ASRResult
from realtime_asr_engine import AudioFormat
from realtime_asr_engine import LiveASRRunner
from realtime_asr_engine import LiveASRRunnerSettings
from realtime_asr_engine import TranscriptSegment
from realtime_translation_engine import LiveRunner
from realtime_translation_engine import PreviewTranslationSettings
from realtime_translation_engine import SourceEvent
from realtime_translation_engine import SourceTranscriptState
from realtime_translation_engine import TranslationCore
from realtime_translation_engine.types import LiveDispatchRequest

from app.asr_bridge import ASRJob
from app.asr_bridge import LiveASRPoolBridge
from app.config import get_bool, get_float, get_int, optional_str
from app.protocol import event
from app.sessions import ConversationSession
from app.sessions import SESSIONS
from app.translation_bridge import TranslationBridge
from app.tts_bridge import TTSBridge


_ASR_LANGUAGE_CODES = {
    "arabic": "ar",
    "chinese": "zh",
    "dutch": "nl",
    "english": "en",
    "french": "fr",
    "german": "de",
    "italian": "it",
    "japanese": "ja",
    "korean": "ko",
    "polish": "pl",
    "portuguese": "pt",
    "spanish": "es",
    "turkish": "tr",
    "ukrainian": "uk",
}


@dataclass
class ConversationTurn:
    turn_id: str
    source_committed_text: str = ""
    source_preview_text: str = ""
    target_committed_text: str = ""
    target_preview_text: str = ""


@dataclass
class LaneASRJob:
    job: ASRJob
    turn_id: str


@dataclass
class ConversationLane:
    lane_id: str
    source_language: str
    target_language: str
    asr_language: str | None
    asr_runner: LiveASRRunner
    translation_runner: LiveRunner
    translation_bridge: TranslationBridge
    current_turn: ConversationTurn
    source_state: SourceTranscriptState = field(default_factory=SourceTranscriptState)
    asr_inflight: LaneASRJob | None = None
    translation_task: asyncio.Task[Any] | None = None
    last_target_committed: str = ""
    line_number: int = 0
    turn_counter: int = 1
    kept_turn_history: list[dict[str, Any]] = field(default_factory=list)
    spoken_clip_history: list[dict[str, Any]] = field(default_factory=list)
    pending_tts: dict[str, Any] | None = None


class ConversationRuntime:
    def __init__(self, *, websocket: WebSocket, session: ConversationSession) -> None:
        self.websocket = websocket
        self.session = session
        self.session_id = session.session_id
        self.sample_rate_hz = get_int("live.audio.sample_rate_hz", 16000, min_value=8000)
        self.channels = get_int("live.audio.channels", 1, min_value=1)
        self.sample_width_bytes = 2
        self.side_a_language = session.side_a_language
        self.side_b_language = session.side_b_language
        self.active_lane_id = "a_to_b"
        self.asr_bridge = LiveASRPoolBridge(
            session_id=self.session_id,
            sample_rate_hz=self.sample_rate_hz,
            channels=self.channels,
        )
        self.tts_bridge = TTSBridge()
        self.lanes = {
            "a_to_b": self._build_lane(
                lane_id="a_to_b",
                source_language=self.side_a_language,
                target_language=self.side_b_language,
            ),
            "b_to_a": self._build_lane(
                lane_id="b_to_a",
                source_language=self.side_b_language,
                target_language=self.side_a_language,
            ),
        }
        self.asr_ready: asyncio.Event | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.send_lock = asyncio.Lock()
        self.listening = False
        self.closed = False

    async def run(self) -> None:
        await self.websocket.accept()
        self.loop = asyncio.get_running_loop()
        self.asr_ready = asyncio.Event()
        try:
            for lane in self.lanes.values():
                lane.asr_runner.ensure_vad_ready()
        except Exception as exc:
            await self._send(event("error", self.session_id, code="vad_init_failed", message=str(exc), fatal=True))
            await self.websocket.close(code=status.WS_1011_INTERNAL_ERROR, reason="vad_init_failed")
            return

        self.asr_bridge.start_completion_stream(on_terminal_event=self._notify_asr_ready)
        await self._send(
            event(
                "ready",
                self.session_id,
                audio_input={
                    "format": "pcm16le",
                    "sample_rate_hz": self.sample_rate_hz,
                    "channels": self.channels,
                },
                side_a_language=self.side_a_language,
                side_b_language=self.side_b_language,
                active_lane_id=self.active_lane_id,
                lanes={lane_id: self._lane_payload(lane) for lane_id, lane in self.lanes.items()},
            )
        )
        try:
            while not self.closed:
                kind, incoming = await self._wait_for_input()
                if kind == "asr":
                    await self._process_asr(force=False)
                    continue
                if incoming is None:
                    continue
                if incoming.get("type") == "websocket.disconnect":
                    break
                raw_bytes = incoming.get("bytes")
                if raw_bytes is not None:
                    await self._handle_audio(raw_bytes)
                    continue
                raw_text = incoming.get("text")
                if raw_text is not None:
                    keep_open = await self._handle_control(raw_text)
                    if not keep_open:
                        break
        finally:
            await self._cleanup()

    def _notify_asr_ready(self) -> None:
        loop = self.loop
        ready = self.asr_ready
        if loop is None or ready is None:
            return
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(ready.set)

    async def _wait_for_input(self) -> tuple[str, dict[str, Any] | None]:
        ready = self.asr_ready
        if ready is not None and ready.is_set():
            ready.clear()
            return "asr", None

        receive_task = asyncio.create_task(self.websocket.receive())
        tasks: set[asyncio.Task[Any]] = {receive_task}
        ready_task: asyncio.Task[Any] | None = None
        if ready is not None:
            ready_task = asyncio.create_task(ready.wait())
            tasks.add(ready_task)
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)

        if receive_task in done:
            await _cancel_task(ready_task)
            return "websocket", receive_task.result()

        if ready is not None:
            ready.clear()
        await _cancel_task(receive_task)
        return "asr", None

    async def _handle_control(self, raw_text: str) -> bool:
        import json

        try:
            payload = json.loads(raw_text)
        except Exception:
            await self._send(event("error", self.session_id, code="invalid_json", message="Invalid control message."))
            return True
        msg_type = str(payload.get("type") or "").strip().lower()
        if msg_type == "start_listening":
            self.listening = True
            SESSIONS.update(self.session_id, state="listening")
            await self._send(event("state", self.session_id, state="listening"))
            return True
        if msg_type == "pause_listening":
            await self._pause_listening()
            return False
        if msg_type == "set_active_lane":
            await self._set_active_lane(lane_id=payload.get("lane_id"))
            return True
        if msg_type == "reset_turn":
            await self._reset_turn()
            return True
        if msg_type == "speak_now":
            await self._speak_now()
            return True
        if msg_type == "tts_playback_complete":
            await self._tts_playback_complete(payload)
            return True
        await self._send(event("error", self.session_id, code="unsupported_control", message=msg_type))
        return True

    async def _handle_audio(self, raw_bytes: bytes) -> None:
        if not self.listening:
            return
        raw = bytes(raw_bytes or b"")
        remainder = len(raw) % self.sample_width_bytes
        if remainder:
            raw = raw[:-remainder]
        if not raw:
            return
        self._active_lane().asr_runner.ingest_audio(raw)
        await self._process_asr(force=False)

    async def _process_asr(self, *, force: bool) -> None:
        await self._poll_asr_all()
        await self._enqueue_asr(self._active_lane(), force=force)

    async def _poll_asr_all(self) -> None:
        for lane in list(self.lanes.values()):
            await self._poll_asr_lane(lane)

    async def _poll_asr_lane(self, lane: ConversationLane) -> None:
        inflight = lane.asr_inflight
        if inflight is None:
            return
        job = inflight.job
        if not self.asr_bridge.has_terminal_result(job.request_id):
            return
        result = await asyncio.to_thread(
            self.asr_bridge.take_terminal_result,
            job.request_id,
            t0_offset_ms=job.t0_ms,
        )
        if not result.done:
            return

        is_current_turn = inflight.turn_id == lane.current_turn.turn_id
        if result.ok:
            apply = lane.asr_runner.apply_result(
                ASRResult(
                    sequence_id=self._sequence_from_request(job.request_id),
                    t0_ms=job.t0_ms,
                    t1_ms=job.t1_ms,
                    ok=True,
                    text=result.text,
                    segments=tuple(
                        TranscriptSegment.from_dict(seg)
                        for seg in (result.segments or [])
                        if isinstance(seg, dict)
                    ),
                )
            )
            if is_current_turn and apply.reason == "commit_applied" and apply.committed_segments:
                text = " ".join(seg.text.strip() for seg in apply.committed_segments if seg.text.strip()).strip()
                if text:
                    await self._source_event(lane, kind="c", text=text)
            preview_text = str(apply.preview.text or "").strip()
            if is_current_turn and apply.reason in {"preview_applied", "commit_applied"} and preview_text:
                await self._source_event(lane, kind="p", text=preview_text)
        else:
            lane.asr_runner.apply_result(
                ASRResult(
                    sequence_id=self._sequence_from_request(job.request_id),
                    t0_ms=job.t0_ms,
                    t1_ms=job.t1_ms,
                    ok=False,
                    error=result.error,
                )
            )
            await self._send(
                event(
                    "error",
                    self.session_id,
                    code="asr_error",
                    message=result.error,
                    lane_id=lane.lane_id,
                    turn_id=inflight.turn_id,
                )
            )
        lane.asr_inflight = None

    async def _enqueue_asr(self, lane: ConversationLane, *, force: bool) -> None:
        if lane.asr_inflight is not None:
            return
        if not self.listening and not force:
            return
        decision = lane.asr_runner.maybe_dispatch_work(now_mono=time.monotonic(), force=force)
        await self._send_vad_state(lane, decision)
        if decision.error:
            await self._send(
                event(
                    "error",
                    self.session_id,
                    code="asr_dispatch_error",
                    message=decision.error,
                    lane_id=lane.lane_id,
                    turn_id=lane.current_turn.turn_id,
                )
            )
            return
        if decision.speech_gate_decision is not None and decision.speech_gate_decision.force_commit_requested:
            await self._commit_preview_tail(lane, speech_gate_forced=True)
        work = decision.work_decision.work_item
        if work is None:
            return
        try:
            job = await asyncio.to_thread(
                self.asr_bridge.enqueue_pcm16,
                lane_id=lane.lane_id,
                chunk_index=work.sequence_id,
                t0_ms=work.t0_ms,
                t1_ms=work.t1_ms,
                pcm16le=work.pcm16le,
                language=lane.asr_language,
            )
        except Exception as exc:
            lane.asr_runner.rollback_inflight_work(sequence_id=work.sequence_id)
            await self._send(
                event(
                    "error",
                    self.session_id,
                    code="asr_submit_failed",
                    message=str(exc),
                    lane_id=lane.lane_id,
                    turn_id=lane.current_turn.turn_id,
                )
            )
            return
        lane.asr_inflight = LaneASRJob(job=job, turn_id=lane.current_turn.turn_id)
        await self._send(
            event(
                "asr_status",
                self.session_id,
                state="inflight",
                lane_id=lane.lane_id,
                turn_id=lane.current_turn.turn_id,
            )
        )

    async def _send_vad_state(self, lane: ConversationLane, decision: Any) -> None:
        observation = getattr(decision, "speech_observation", None)
        if observation is None:
            return
        speech_detected = bool(getattr(observation, "speech_hit", False))
        default_reason = "speech" if speech_detected else "silence"
        gate = getattr(decision, "speech_gate_decision", None)
        await self._send(
            event(
                "vad_state",
                self.session_id,
                lane_id=lane.lane_id,
                turn_id=lane.current_turn.turn_id,
                phase="speech" if speech_detected else "silence",
                speech_detected=speech_detected,
                reason=str(getattr(observation, "reason", "") or default_reason),
                speech_ms=int(max(0, int(getattr(observation, "speech_ms", 0) or 0))),
                segments_count=int(max(0, int(getattr(observation, "segments_count", 0) or 0))),
                speech_gate_state=str(getattr(gate, "next_state", "") or ""),
            )
        )

    async def _commit_preview_tail(self, lane: ConversationLane, *, speech_gate_forced: bool = False) -> None:
        segment = lane.asr_runner.commit_preview_tail(speech_gate_forced=speech_gate_forced)
        if segment is None:
            return
        text = str(segment.text or "").strip()
        if text:
            await self._source_event(lane, kind="c", text=text)

    async def _set_active_lane(self, *, lane_id: Any) -> None:
        next_lane_id = str(lane_id or "").strip()
        if next_lane_id not in self.lanes:
            await self._send(
                event(
                    "error",
                    self.session_id,
                    code="invalid_lane",
                    message=next_lane_id or "missing_lane_id",
                )
            )
            return
        if next_lane_id != self.active_lane_id:
            await self._start_new_turn(self._active_lane(), keep=True)
        self.active_lane_id = next_lane_id
        lane = self._active_lane()
        await self._send(
            event(
                "active_lane_changed",
                self.session_id,
                active_lane_id=self.active_lane_id,
                lane=self._lane_payload(lane),
            )
        )

    async def _reset_turn(self) -> None:
        lane = self._active_lane()
        old_turn_id = lane.current_turn.turn_id
        await self._start_new_turn(lane, keep=False)
        await self._send(
            event(
                "turn_reset_ack",
                self.session_id,
                lane_id=lane.lane_id,
                old_turn_id=old_turn_id,
                new_turn_id=lane.current_turn.turn_id,
            )
        )

    async def _speak_now(self) -> None:
        lane = self._active_lane()
        turn = lane.current_turn
        text = _visible_text(turn.target_committed_text, turn.target_preview_text)
        if not text:
            await self._send(
                event(
                    "tts_status",
                    self.session_id,
                    state="skipped",
                    reason="empty_target",
                    lane_id=lane.lane_id,
                    turn_id=turn.turn_id,
                    message="No translation yet",
                )
            )
            return
        if not self.tts_bridge.enabled:
            await self._send(
                event(
                    "tts_status",
                    self.session_id,
                    state="disabled",
                    reason="tts_disabled",
                    lane_id=lane.lane_id,
                    turn_id=turn.turn_id,
                    message="Audio output is off",
                )
            )
            return
        try:
            tts_payload = await asyncio.to_thread(
                self.tts_bridge.synthesize,
                session_id=self.session_id,
                text=text,
                language=lane.target_language,
            )
        except Exception as exc:
            await self._send(
                event(
                    "error",
                    self.session_id,
                    code="tts_failed",
                    message=str(exc),
                    lane_id=lane.lane_id,
                    turn_id=turn.turn_id,
                )
            )
            return
        if lane.current_turn.turn_id != turn.turn_id:
            return
        lane.pending_tts = {
            "turn_id": turn.turn_id,
            "artifact_id": tts_payload.get("artifact_id"),
            "text": text,
            "tts": dict(tts_payload),
        }
        await self._send(
            event(
                "tts_clip_ready",
                self.session_id,
                lane_id=lane.lane_id,
                turn_id=turn.turn_id,
                tts=tts_payload,
            )
        )

    async def _tts_playback_complete(self, payload: dict[str, Any]) -> None:
        lane_id = str(payload.get("lane_id") or "").strip()
        turn_id = str(payload.get("turn_id") or "").strip()
        artifact_id = str(payload.get("artifact_id") or "").strip()
        lane = self.lanes.get(lane_id)
        if lane is None:
            return
        pending = lane.pending_tts or {}
        if turn_id != lane.current_turn.turn_id:
            return
        if turn_id != str(pending.get("turn_id") or ""):
            return
        if artifact_id and artifact_id != str(pending.get("artifact_id") or ""):
            return
        lane.spoken_clip_history.append(dict(pending))
        lane.pending_tts = None

    async def _source_event(self, lane: ConversationLane, *, kind: str, text: str) -> None:
        turn_id = lane.current_turn.turn_id
        lane.line_number += 1
        source_event = SourceEvent(kind=kind, text=text, line_number=lane.line_number)
        lane.source_state.apply_event(source_event)
        turn = lane.current_turn

        if kind == "c":
            turn.source_committed_text = lane.source_state.source_committed_text
            turn.source_preview_text = ""
            await self._send(
                event(
                    "source_update",
                    self.session_id,
                    lane_id=lane.lane_id,
                    turn_id=turn_id,
                    reset=False,
                    committed_append=text,
                    preview="",
                )
            )
        else:
            turn.source_preview_text = lane.source_state.source_preview_text
            await self._send(
                event(
                    "source_update",
                    self.session_id,
                    lane_id=lane.lane_id,
                    turn_id=turn_id,
                    reset=False,
                    committed_append="",
                    preview=lane.source_state.source_preview_text,
                )
            )

        step = lane.translation_runner.on_source_event(source_event, lane.source_state)
        if step.dispatch_request is not None:
            self._schedule_translation(lane, step.dispatch_request, turn_id=turn_id)

    def _schedule_translation(self, lane: ConversationLane, request: LiveDispatchRequest, *, turn_id: str) -> None:
        if lane.translation_task is not None and not lane.translation_task.done():
            return
        lane.translation_task = asyncio.create_task(self._run_translation(lane.lane_id, turn_id, request))

    async def _run_translation(self, lane_id: str, turn_id: str, request: LiveDispatchRequest) -> None:
        lane = self.lanes[lane_id]
        current_task = asyncio.current_task()
        try:
            translation = await asyncio.to_thread(lane.translation_bridge.run, request)
            if lane.current_turn.turn_id != turn_id:
                return
            step = lane.translation_runner.on_llm_result(request, translation.text)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._send(
                event(
                    "error",
                    self.session_id,
                    code="translation_failed",
                    message=str(exc),
                    lane_id=lane_id,
                    turn_id=turn_id,
                )
            )
            return
        finally:
            if lane.translation_task is current_task:
                lane.translation_task = None

        if lane.current_turn.turn_id != turn_id:
            return
        target_state = lane.translation_runner.target_state
        committed = str(target_state.target_committed_text or "")
        reset = not committed.startswith(lane.last_target_committed)
        committed_append = committed if reset else committed[len(lane.last_target_committed) :]
        lane.last_target_committed = committed

        turn = lane.current_turn
        turn.target_committed_text = committed
        turn.target_preview_text = str(target_state.target_preview_text or "")
        await self._send(
            event(
                "target_update",
                self.session_id,
                lane_id=lane.lane_id,
                turn_id=turn_id,
                reset=reset,
                committed_append=committed_append,
                preview=turn.target_preview_text,
                reason=step.reason,
                wall_ms=round(float(translation.wall_ms), 1),
                model=translation.model,
                tts=None,
            )
        )
        if step.dispatch_request is not None:
            self._schedule_translation(lane, step.dispatch_request, turn_id=turn_id)

    async def _start_new_turn(self, lane: ConversationLane, *, keep: bool) -> None:
        if keep and _turn_has_text(lane.current_turn):
            lane.kept_turn_history.append(
                {
                    "turn_id": lane.current_turn.turn_id,
                    "source_text": _visible_text(
                        lane.current_turn.source_committed_text,
                        lane.current_turn.source_preview_text,
                    ),
                    "target_text": _visible_text(
                        lane.current_turn.target_committed_text,
                        lane.current_turn.target_preview_text,
                    ),
                }
            )
        self._close_asr_scope_for_new_turn(lane)
        await _cancel_task(lane.translation_task)
        lane.translation_task = None
        lane.turn_counter += 1
        lane.current_turn = ConversationTurn(turn_id=f"{lane.lane_id}_turn_{lane.turn_counter}")
        lane.source_state = SourceTranscriptState()
        lane.translation_runner = self._build_translation_runner()
        lane.last_target_committed = ""
        lane.pending_tts = None
        await self._send(
            event(
                "source_update",
                self.session_id,
                lane_id=lane.lane_id,
                turn_id=lane.current_turn.turn_id,
                reset=True,
                committed_append="",
                preview="",
            )
        )
        await self._send(
            event(
                "target_update",
                self.session_id,
                lane_id=lane.lane_id,
                turn_id=lane.current_turn.turn_id,
                reset=True,
                committed_append="",
                preview="",
                reason="new_turn",
                tts=None,
            )
        )

    def _close_asr_scope_for_new_turn(self, lane: ConversationLane) -> None:
        inflight = lane.asr_inflight
        if inflight is not None:
            sequence_id = self._sequence_from_request(inflight.job.request_id)
            lane.asr_runner.clear_inflight_work(sequence_id=sequence_id)
            self.asr_bridge.discard_request(inflight.job.request_id)
            lane.asr_inflight = None
        lane.asr_runner.manual_commit_preview()
        lane.asr_runner.advance_offsets_to(
            t1_ms=lane.asr_runner.recording_duration_ms,
            update_last_submitted=True,
        )

    async def _pause_listening(self) -> None:
        self.listening = False
        SESSIONS.update(self.session_id, state="finalizing")
        await self._send(event("state", self.session_id, state="finalizing"))
        for lane in self.lanes.values():
            lane.asr_runner.finalize_input()
        await self._poll_asr_all()
        for lane in self.lanes.values():
            await self._enqueue_asr(lane, force=True)
        deadline = time.monotonic() + get_float("live.timing.drain_wait_s", 20.0, min_value=0.0)
        while any(lane.asr_inflight is not None for lane in self.lanes.values()) and time.monotonic() < deadline:
            await self._poll_asr_all()
            if not any(lane.asr_inflight is not None for lane in self.lanes.values()):
                break
            ready = self.asr_ready
            timeout = min(0.1, max(0.0, deadline - time.monotonic()))
            if ready is not None:
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(ready.wait(), timeout=timeout)
                    ready.clear()
            else:
                await asyncio.sleep(timeout)
        for lane in self.lanes.values():
            await self._commit_preview_tail(lane)
        tasks = [lane.translation_task for lane in self.lanes.values() if lane.translation_task is not None and not lane.translation_task.done()]
        if tasks:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.gather(*tasks), timeout=30.0)
        SESSIONS.update(self.session_id, state="completed")
        await self._send(event("ended", self.session_id, reason="pause_listening"))
        with contextlib.suppress(Exception):
            await self.websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
        self.closed = True

    async def _cleanup(self) -> None:
        self.closed = True
        for lane in self.lanes.values():
            await _cancel_task(lane.translation_task)
            lane.translation_task = None
        self.asr_bridge.stop_completion_stream()
        SESSIONS.close(self.session_id, reason="closed")

    async def _send(self, payload: dict[str, Any]) -> None:
        async with self.send_lock:
            await self.websocket.send_json(payload)

    def _active_lane(self) -> ConversationLane:
        return self.lanes[self.active_lane_id]

    def _build_lane(self, *, lane_id: str, source_language: str, target_language: str) -> ConversationLane:
        asr_language = optional_str("live.asr.language") or _asr_language_for(source_language)
        return ConversationLane(
            lane_id=lane_id,
            source_language=source_language,
            target_language=target_language,
            asr_language=asr_language,
            asr_runner=self._build_asr_runner(asr_language=asr_language),
            translation_runner=self._build_translation_runner(),
            translation_bridge=TranslationBridge(
                source_language=source_language,
                target_language=target_language,
            ),
            current_turn=ConversationTurn(turn_id=f"{lane_id}_turn_1"),
        )

    def _build_asr_runner(self, *, asr_language: str | None) -> LiveASRRunner:
        audio_format = AudioFormat(
            sample_rate_hz=self.sample_rate_hz,
            channels=self.channels,
            sample_width_bytes=self.sample_width_bytes,
        )
        settings = LiveASRRunnerSettings.from_live_config(
            {
                "timing": {
                    "emit_min_ms": get_int("live.timing.emit_min_ms", 120, min_value=0),
                },
                "rolling": {
                    "min_infer_audio_ms": get_int("live.rolling.min_infer_audio_ms", 500, min_value=200),
                    "single_segment_commit_min_ms": get_int("live.rolling.single_segment_commit_min_ms", 12000, min_value=1000),
                    "force_commit_repeats": get_int("live.rolling.force_commit_repeats", 3, min_value=1),
                    "max_uncommitted_ms": get_int("live.rolling.max_uncommitted_ms", 30000, min_value=1000),
                    "hard_clip_keep_tail_ms": get_int("live.rolling.hard_clip_keep_tail_ms", 5000, min_value=1000),
                    "max_decode_window_ms": get_int("live.rolling.max_decode_window_ms", 12000, min_value=1000),
                    "buffer_trim_threshold_ms": get_int("live.rolling.buffer_trim_threshold_ms", 30000, min_value=5000),
                    "buffer_trim_drop_ms": get_int("live.rolling.buffer_trim_drop_ms", 20000, min_value=1000),
                    "min_new_audio_ms": get_int("live.rolling.min_new_audio_ms", 500, min_value=0),
                    "pacing": {
                        "base_emit_ms": get_int("live.rolling.pacing.base_emit_ms", 250, min_value=1),
                        "startup": {
                            "duration_ms": get_int("live.rolling.pacing.startup.duration_ms", 1200, min_value=0),
                            "emit_ms": get_int("live.rolling.pacing.startup.emit_ms", 100, min_value=1),
                            "min_infer_audio_ms": get_int("live.rolling.pacing.startup.min_infer_audio_ms", 250, min_value=0),
                            "min_new_audio_ms": get_int("live.rolling.pacing.startup.min_new_audio_ms", 200, min_value=0),
                        },
                    },
                    "vad": {
                        "enabled": get_bool("live.rolling.vad.enabled", True),
                        "venv": optional_str("live.rolling.vad.venv"),
                        "threshold": get_float("live.rolling.vad.threshold", 0.35, min_value=0.0),
                        "max_speech_duration_s": get_float("live.rolling.vad.max_speech_duration_s", 12.0, min_value=0.1),
                        "min_speech_ms": get_int("live.rolling.vad.min_speech_ms", 120, min_value=0),
                        "hangover_ms": get_int("live.rolling.vad.hangover_ms", 600, min_value=0),
                    },
                    "speech_gate": {
                        "silence_enter_ms": get_int("live.rolling.speech_gate.silence_enter_ms", 900, min_value=100),
                        "rearm_hits": get_int("live.rolling.speech_gate.rearm_hits", 2, min_value=1),
                        "rearm_window_ms": get_int("live.rolling.speech_gate.rearm_window_ms", 500, min_value=100),
                        "force_commit_silence_ms": get_int("live.rolling.speech_gate.force_commit_silence_ms", 2500, min_value=100),
                    },
                },
            }
        )
        return LiveASRRunner(audio_format=audio_format, settings=settings, language=asr_language)

    def _build_translation_runner(self) -> LiveRunner:
        return LiveRunner(
            core=TranslationCore(
                preview_settings=PreviewTranslationSettings(
                    enabled=get_bool("translation.preview.enabled", False),
                    min_chars=get_int("translation.preview.min_chars", 80),
                    max_distance_ratio=get_float("translation.preview.max_distance_ratio", 0.15),
                    min_growth_chars=get_int("translation.preview.min_growth_chars", 50),
                )
            )
        )

    @staticmethod
    def _sequence_from_request(request_id: str) -> int:
        parts = str(request_id or "").split("_")
        for part in parts:
            if part.isdigit() and len(part) == 6:
                return int(part)
        return 0

    @staticmethod
    def _lane_payload(lane: ConversationLane) -> dict[str, Any]:
        return {
            "lane_id": lane.lane_id,
            "source_language": lane.source_language,
            "target_language": lane.target_language,
            "asr_language": lane.asr_language,
            "current_turn_id": lane.current_turn.turn_id,
        }


async def _cancel_task(task: asyncio.Task[Any] | None) -> None:
    if task is None or task.done():
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


def _asr_language_for(language: str) -> str | None:
    key = str(language or "").strip().lower()
    if not key:
        return None
    return _ASR_LANGUAGE_CODES.get(key) or (key if len(key) == 2 else None)


def _visible_text(committed: str, preview: str) -> str:
    committed_text = str(committed or "").strip()
    preview_text = str(preview or "").strip()
    if not committed_text:
        return preview_text
    if not preview_text:
        return committed_text
    return f"{committed_text} {preview_text}"


def _turn_has_text(turn: ConversationTurn) -> bool:
    return bool(
        _visible_text(turn.source_committed_text, turn.source_preview_text)
        or _visible_text(turn.target_committed_text, turn.target_preview_text)
    )
