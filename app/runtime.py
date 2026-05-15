from __future__ import annotations

import asyncio
import contextlib
import time
from copy import deepcopy
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
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
from app.live_settings import default_live_settings
from app.live_settings import live_runner_config
from app.live_settings import merge_live_settings
from app.live_settings import normalize_live_settings_delta
from app.protocol import event
from app.sessions import ConversationSession
from app.sessions import SESSIONS
from app.translation_bridge import TranslationBridge
from app.tts_bridge import get_tts_bridge
from app.tts_bridge import tts_uses_asr_reference_wav


_ASR_LANGUAGE_CODES = {
    "arabic": "ar",
    "brazilian portuguese": "pt",
    "british english": "en",
    "chinese": "zh",
    "dutch": "nl",
    "english": "en",
    "french": "fr",
    "german": "de",
    "hindi": "hi",
    "italian": "it",
    "japanese": "ja",
    "korean": "ko",
    "polish": "pl",
    "portuguese": "pt",
    "spanish": "es",
    "turkish": "tr",
    "ukrainian": "uk",
}


class TurnState(StrEnum):
    OPEN_EMPTY = "open_empty"
    OPEN_ACTIVE_UNSPOKEN = "open_active_unspoken"
    OPEN_SPEAKING = "open_speaking"
    OPEN_SPOKEN_IDLE = "open_spoken_idle"
    CLOSED = "closed"


OPEN_TURN_STATES = {
    TurnState.OPEN_EMPTY,
    TurnState.OPEN_ACTIVE_UNSPOKEN,
    TurnState.OPEN_SPEAKING,
    TurnState.OPEN_SPOKEN_IDLE,
}


def is_open_turn(state: TurnState) -> bool:
    return state in OPEN_TURN_STATES


@dataclass
class TurnPart:
    part_id: str
    source_committed_text: str = ""
    source_preview_text: str = ""
    target_committed_text: str = ""
    target_preview_text: str = ""
    speech_state: str = "pending"


@dataclass
class ConversationTurn:
    turn_id: str
    lane_id: str
    direction: str
    state: TurnState = TurnState.OPEN_EMPTY
    parts: list[TurnPart] = field(default_factory=list)


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
    source_state: SourceTranscriptState = field(default_factory=SourceTranscriptState)
    asr_inflight: LaneASRJob | None = None
    translation_task: asyncio.Task[Any] | None = None
    translation_generation: int = 0
    tts_task: asyncio.Task[Any] | None = None
    last_target_committed: str = ""
    line_number: int = 0
    pending_tts: dict[str, Any] | None = None
    last_asr_segments: list[dict[str, Any]] = field(default_factory=list)
    last_asr_request_id: str = ""
    last_asr_backend: str = ""
    last_asr_wav_path: str = ""


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
        self.live_settings = merge_live_settings(default_live_settings(), session.live_settings or {})
        self.asr_bridge = LiveASRPoolBridge(
            session_id=self.session_id,
            sample_rate_hz=self.sample_rate_hz,
            channels=self.channels,
            live_settings=self.live_settings,
        )
        self.tts_bridge = get_tts_bridge()
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
        self.turn_counter = 1
        self.current_turn = self._new_turn(lane_id="a_to_b")
        self.closed_turns: list[ConversationTurn] = []
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
                live_settings=deepcopy(self.live_settings),
                lanes={lane_id: self._lane_payload(lane) for lane_id, lane in self.lanes.items()},
                current_turn=self._turn_payload(self.current_turn),
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
        if msg_type == "next_turn":
            await self._next_turn(lane_id=payload.get("lane_id"))
            return True
        if msg_type == "speak_now":
            await self._speak_now()
            return True
        if msg_type == "translate_now":
            await self._translate_now()
            return True
        if msg_type == "replay_tts":
            await self._replay_tts(payload)
            return True
        if msg_type == "update_live_settings":
            await self._update_live_settings(payload)
            return True
        if msg_type == "tts_playback_complete":
            await self._tts_playback_complete(payload)
            return True
        await self._send(event("error", self.session_id, code="unsupported_control", message=msg_type))
        return True

    async def _update_live_settings(self, payload: dict[str, Any]) -> None:
        delta, errors = normalize_live_settings_delta(payload.get("settings"), live_update=True)
        if errors:
            await self._send(
                event(
                    "error",
                    self.session_id,
                    code="invalid_live_settings",
                    message="; ".join(errors),
                )
            )
            return
        if not delta:
            await self._send(event("live_settings", self.session_id, live_settings=deepcopy(self.live_settings)))
            return
        self.live_settings = merge_live_settings(self.live_settings, delta)
        self.asr_bridge.live_settings = self.live_settings
        self._apply_live_runner_settings()
        await self._send(event("live_settings", self.session_id, live_settings=deepcopy(self.live_settings)))

    async def _handle_audio(self, raw_bytes: bytes) -> None:
        if not self.listening:
            return
        raw = bytes(raw_bytes or b"")
        remainder = len(raw) % self.sample_width_bytes
        if remainder:
            raw = raw[:-remainder]
        if not raw:
            return
        if self.current_turn.state == TurnState.OPEN_SPEAKING:
            return
        self._current_lane().asr_runner.ingest_audio(raw)
        await self._process_asr(force=False)

    async def _process_asr(self, *, force: bool) -> None:
        await self._poll_asr_all()
        if self.current_turn.state != TurnState.OPEN_SPEAKING:
            await self._enqueue_asr(self._current_lane(), force=force)

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

        is_current_turn = inflight.turn_id == self.current_turn.turn_id
        if result.ok:
            result_segments = [dict(seg) for seg in (result.segments or []) if isinstance(seg, dict)]
            result_backend = str(result.asr_backend or _live_settings_asr_backend(self.live_settings))
            lane.last_asr_segments = list(result_segments)
            lane.last_asr_request_id = str(result.request_id or job.request_id)
            lane.last_asr_backend = result_backend
            lane.last_asr_wav_path = str(job.wav_path)
            apply = lane.asr_runner.apply_result(
                ASRResult(
                    sequence_id=self._sequence_from_request(job.request_id),
                    t0_ms=job.t0_ms,
                    t1_ms=job.t1_ms,
                    ok=True,
                    text=result.text,
                    segments=tuple(
                        TranscriptSegment.from_dict(seg)
                        for seg in result_segments
                    ),
                )
            )
            if (
                is_current_turn
                and self.current_turn.state != TurnState.OPEN_SPEAKING
                and apply.reason == "commit_applied"
                and apply.committed_segments
            ):
                text = " ".join(seg.text.strip() for seg in apply.committed_segments if seg.text.strip()).strip()
                if text:
                    start_ms, end_ms = _segment_span(apply.committed_segments)
                    await self._source_event(
                        lane,
                        kind="c",
                        text=text,
                        speech_start_ms=start_ms,
                        speech_end_ms=end_ms,
                        asr_debug=_asr_debug_for_interval(
                            backend=result_backend,
                            request_id=str(result.request_id or job.request_id),
                            segments=result_segments,
                            speech_start_ms=start_ms,
                            speech_end_ms=end_ms,
                        ),
                        pc_reason=str(apply.commit_reason or apply.reason or ""),
                    )
            preview_text = str(apply.preview.text or "").strip()
            if (
                is_current_turn
                and self.current_turn.state != TurnState.OPEN_SPEAKING
                and apply.reason in {"preview_applied", "commit_applied"}
                and preview_text
            ):
                preview_start_ms = _preview_start_ms(lane)
                preview_end_ms = int(max(preview_start_ms, int(apply.preview.audio_end_ms or 0)))
                await self._source_event(
                    lane,
                    kind="p",
                    text=preview_text,
                    speech_start_ms=preview_start_ms,
                    speech_end_ms=preview_end_ms,
                    asr_debug=_asr_debug_for_interval(
                        backend=result_backend,
                        request_id=str(result.request_id or job.request_id),
                        segments=result_segments,
                        speech_start_ms=preview_start_ms,
                        speech_end_ms=preview_end_ms,
                    ),
                    pc_reason=str(apply.reason or ""),
                )
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
                    turn_id=self.current_turn.turn_id,
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
                    turn_id=self.current_turn.turn_id,
                )
            )
            return
        lane.asr_inflight = LaneASRJob(job=job, turn_id=self.current_turn.turn_id)
        await self._send(
            event(
                "asr_status",
                self.session_id,
                state="inflight",
                lane_id=lane.lane_id,
                turn_id=self.current_turn.turn_id,
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
                turn_id=self.current_turn.turn_id,
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
            await self._source_event(
                lane,
                kind="c",
                text=text,
                speech_start_ms=int(max(0, segment.t0_ms)),
                speech_end_ms=int(max(0, segment.t1_ms)),
                asr_debug=_asr_debug_for_interval(
                    backend=lane.last_asr_backend or _live_settings_asr_backend(self.live_settings),
                    request_id=lane.last_asr_request_id,
                    segments=lane.last_asr_segments,
                    speech_start_ms=int(max(0, segment.t0_ms)),
                    speech_end_ms=int(max(0, segment.t1_ms)),
                ),
                pc_reason="speech_gate_tail_commit" if speech_gate_forced else "rolling_context_tail_commit",
            )

    async def _next_turn(self, *, lane_id: Any) -> None:
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
        previous_turn = await self._close_current_turn()
        self.current_turn = self._new_turn(lane_id=next_lane_id)
        self._reset_lane_text_scope(self._current_lane())
        await self._send_turn_update(reason="next_turn", previous_turn=previous_turn)

    async def _speak_now(self) -> None:
        lane = self._current_lane()
        turn = self.current_turn
        if turn.state == TurnState.OPEN_SPEAKING or lane.tts_task is not None:
            await self._send(
                event(
                    "tts_status",
                    self.session_id,
                    state="busy",
                    reason="tts_busy",
                    lane_id=lane.lane_id,
                    turn_id=turn.turn_id,
                    message="Audio is already being prepared",
                )
            )
            return
        text = _turn_speakable_target_text(turn)
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
        speaking_part_ids = [
            part.part_id
            for part in turn.parts
            if part.speech_state != "spoken" and _part_target_text(part)
        ]
        if not speaking_part_ids:
            return
        self._close_asr_scope_for_turn(lane)
        self._accept_visible_previews_for_parts(lane, part_ids=set(speaking_part_ids))
        for part in turn.parts:
            if part.part_id in speaking_part_ids:
                part.speech_state = "speaking"
        self._refresh_turn_state()
        await self._send_turn_update(reason="speak_now")
        lane.tts_task = asyncio.create_task(
            self._run_tts(lane.lane_id, turn.turn_id, text, speaking_part_ids)
        )

    async def _translate_now(self) -> None:
        lane = self._current_lane()
        turn = self.current_turn
        if turn.state == TurnState.OPEN_SPEAKING:
            await self._send_translation_status(state="skipped", reason="turn_speaking", message="Audio is playing")
            return
        preview_text = _turn_source_preview_text(turn)
        if not preview_text:
            await self._send_translation_status(state="skipped", reason="empty_source_preview", message="No preview yet")
            return
        committed_text = str(lane.source_state.source_committed_text or "")
        commit_text = _commit_event_text_for_preview(committed_text, preview_text)
        if not commit_text.strip():
            await self._send_translation_status(state="skipped", reason="empty_source_preview", message="No preview yet")
            return
        preview_start_ms = _preview_start_ms(lane)
        preview_end_ms = _preview_end_ms(lane, fallback_t1_ms=preview_start_ms)
        asr_debug = _asr_debug_for_interval(
            backend=lane.last_asr_backend or _live_settings_asr_backend(self.live_settings),
            request_id=lane.last_asr_request_id,
            segments=lane.last_asr_segments,
            speech_start_ms=preview_start_ms,
            speech_end_ms=preview_end_ms,
        )
        self._close_asr_scope_for_turn(lane)
        await self._retire_translation_work(lane)
        await self._source_event(
            lane,
            kind="c",
            text=commit_text,
            reason="translate_now",
            speech_start_ms=preview_start_ms,
            speech_end_ms=preview_end_ms,
            asr_debug=asr_debug,
            pc_reason="translate_now",
        )

    async def _replay_tts(self, payload: dict[str, Any]) -> None:
        lane_id = str(payload.get("lane_id") or "").strip()
        text = str(payload.get("text") or "").strip()
        if not text:
            return
        lane = self.lanes.get(lane_id) if lane_id else self._current_lane()
        if lane is None:
            return
        if not self.tts_bridge.enabled:
            return
        try:
            tts_payload = await asyncio.to_thread(
                self.tts_bridge.synthesize,
                session_id=self.session_id,
                text=text,
                language=lane.target_language,
                reference_wav_path=_tts_reference_wav_path(lane),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._send(
                event(
                    "error",
                    self.session_id,
                    code="tts_replay_failed",
                    message=str(exc),
                    lane_id=lane.lane_id,
                )
            )
            return
        await self._send(
            event(
                "tts_replay_ready",
                self.session_id,
                lane_id=lane.lane_id,
                text=text,
                tts=tts_payload,
            )
        )

    async def _run_tts(self, lane_id: str, turn_id: str, text: str, speaking_part_ids: list[str]) -> None:
        lane = self.lanes[lane_id]
        current_task = asyncio.current_task()
        try:
            tts_payload = await asyncio.to_thread(
                self.tts_bridge.synthesize,
                session_id=self.session_id,
                text=text,
                language=lane.target_language,
                reference_wav_path=_tts_reference_wav_path(lane),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self.current_turn.turn_id == turn_id and self.current_turn.state == TurnState.OPEN_SPEAKING:
                for part in self.current_turn.parts:
                    if part.part_id in speaking_part_ids and part.speech_state == "speaking":
                        part.speech_state = "pending"
                self._refresh_turn_state()
                await self._send_turn_update(reason="tts_failed")
            await self._send(
                event(
                    "error",
                    self.session_id,
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

        if self.current_turn.turn_id != turn_id or self.current_turn.state != TurnState.OPEN_SPEAKING:
            return
        lane.pending_tts = {
            "turn_id": turn_id,
            "artifact_id": tts_payload.get("artifact_id"),
            "text": text,
            "part_ids": list(speaking_part_ids),
            "tts": dict(tts_payload),
        }
        await self._send(
            event(
                "tts_clip_ready",
                self.session_id,
                lane_id=lane.lane_id,
                turn_id=turn_id,
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
        if turn_id != self.current_turn.turn_id:
            return
        if turn_id != str(pending.get("turn_id") or ""):
            return
        if artifact_id and artifact_id != str(pending.get("artifact_id") or ""):
            return
        part_ids = {str(part_id) for part_id in pending.get("part_ids", [])}
        for part in self.current_turn.parts:
            if part.part_id in part_ids and part.speech_state == "speaking":
                part.speech_state = "spoken"
        lane.pending_tts = None
        await _cancel_task(lane.translation_task)
        self._reset_lane_text_scope(lane)
        self._refresh_turn_state()
        await self._send_turn_update(reason="tts_playback_complete")

    async def _source_event(
        self,
        lane: ConversationLane,
        *,
        kind: str,
        text: str,
        reason: str | None = None,
        speech_start_ms: int | None = None,
        speech_end_ms: int | None = None,
        asr_debug: dict[str, Any] | None = None,
        pc_reason: str | None = None,
    ) -> None:
        if lane.lane_id != self.current_turn.lane_id or not is_open_turn(self.current_turn.state):
            return
        if self.current_turn.state == TurnState.OPEN_SPEAKING:
            return
        text = _asr_event_text(lane, kind=kind, text=text)
        if not text.strip():
            return
        turn_id = self.current_turn.turn_id
        lane.line_number += 1
        source_event = SourceEvent(kind=kind, text=text, line_number=lane.line_number)
        self._record_pc_event(
            lane,
            kind=kind,
            text=text,
            turn_id=turn_id,
            line_number=lane.line_number,
            speech_start_ms=speech_start_ms,
            speech_end_ms=speech_end_ms,
            asr_debug=asr_debug,
            reason=pc_reason or reason or f"source_{kind}",
        )
        lane.source_state.apply_event(source_event)
        part = self._current_writable_part()

        if kind == "c":
            part.source_committed_text = lane.source_state.source_committed_text
            part.source_preview_text = ""
        else:
            part.source_preview_text = lane.source_state.source_preview_text

        self._refresh_turn_state()
        await self._send_turn_update(reason=reason or f"source_{kind}")

        step = lane.translation_runner.on_source_event(source_event, lane.source_state)
        if step.dispatch_request is not None:
            self._schedule_translation(lane, step.dispatch_request, turn_id=turn_id)

    def _record_pc_event(
        self,
        lane: ConversationLane,
        *,
        kind: str,
        text: str,
        turn_id: str,
        line_number: int,
        speech_start_ms: int | None,
        speech_end_ms: int | None,
        asr_debug: dict[str, Any] | None,
        reason: str,
    ) -> None:
        safe_kind = str(kind or "").strip().lower()
        if safe_kind not in {"p", "c"}:
            return
        payload: dict[str, Any] = {
            "kind": safe_kind,
            "speech_start_ms": int(max(0, speech_start_ms or 0)),
            "speech_end_ms": int(max(0, speech_end_ms or speech_start_ms or 0)),
            "text": str(text or "").strip(),
            "reason": str(reason or ""),
            "lane_id": lane.lane_id,
            "turn_id": turn_id,
            "line_number": int(max(0, line_number)),
        }
        if asr_debug:
            payload["asr_debug"] = deepcopy(asr_debug)
        SESSIONS.append_pc_event(self.session_id, payload)

    async def _retire_translation_work(self, lane: ConversationLane) -> None:
        lane.translation_generation += 1
        await _cancel_task(lane.translation_task)
        lane.translation_task = None
        lane.translation_runner.retire_inflight()

    async def _send_translation_status(self, *, state: str, reason: str, message: str) -> None:
        lane = self._current_lane()
        await self._send(
            event(
                "translation_status",
                self.session_id,
                state=state,
                reason=reason,
                lane_id=lane.lane_id,
                turn_id=self.current_turn.turn_id,
                message=message,
            )
        )

    def _schedule_translation(self, lane: ConversationLane, request: LiveDispatchRequest, *, turn_id: str) -> None:
        if lane.translation_task is not None and not lane.translation_task.done():
            return
        lane.translation_task = asyncio.create_task(
            self._run_translation(lane.lane_id, turn_id, request, lane.translation_generation)
        )

    async def _run_translation(
        self,
        lane_id: str,
        turn_id: str,
        request: LiveDispatchRequest,
        generation: int,
    ) -> None:
        lane = self.lanes[lane_id]
        current_task = asyncio.current_task()
        try:
            translation = await asyncio.to_thread(lane.translation_bridge.run, request)
            if (
                generation != lane.translation_generation
                or self.current_turn.turn_id != turn_id
                or self.current_turn.state == TurnState.OPEN_SPEAKING
            ):
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

        if (
            generation != lane.translation_generation
            or self.current_turn.turn_id != turn_id
            or self.current_turn.state == TurnState.OPEN_SPEAKING
        ):
            return
        target_state = lane.translation_runner.target_state
        committed = str(target_state.target_committed_text or "")
        lane.last_target_committed = committed

        part = self._current_writable_part()
        part.target_committed_text = committed
        part.target_preview_text = str(target_state.target_preview_text or "")
        self._refresh_turn_state()
        await self._send_turn_update(
            reason="translation_update",
            translation={
                "reason": step.reason,
                "wall_ms": round(float(translation.wall_ms), 1),
                "model": translation.model,
            },
        )
        if step.dispatch_request is not None:
            self._schedule_translation(lane, step.dispatch_request, turn_id=turn_id)

    def _new_turn(self, *, lane_id: str) -> ConversationTurn:
        lane = self.lanes[lane_id]
        return ConversationTurn(
            turn_id=f"turn_{self.turn_counter}",
            lane_id=lane_id,
            direction=f"{lane.source_language}->{lane.target_language}",
        )

    async def _close_current_turn(self) -> ConversationTurn:
        turn = self.current_turn
        if not is_open_turn(turn.state):
            return turn
        lane = self.lanes[turn.lane_id]
        self._close_asr_scope_for_turn(lane)
        await _cancel_task(lane.translation_task)
        await _cancel_task(lane.tts_task)
        lane.translation_task = None
        lane.tts_task = None
        lane.pending_tts = None
        turn.state = TurnState.CLOSED
        self.closed_turns.append(turn)
        self.turn_counter += 1
        return turn

    def _reset_lane_text_scope(self, lane: ConversationLane) -> None:
        lane.source_state = SourceTranscriptState()
        lane.translation_runner = self._build_translation_runner()
        lane.translation_generation += 1
        lane.last_target_committed = ""
        lane.line_number = 0
        lane.pending_tts = None

    def _current_writable_part(self) -> TurnPart:
        turn = self.current_turn
        if not turn.parts or turn.parts[-1].speech_state == "spoken":
            turn.parts.append(TurnPart(part_id=f"{turn.turn_id}_part_{len(turn.parts) + 1}"))
        return turn.parts[-1]

    def _refresh_turn_state(self) -> None:
        turn = self.current_turn
        if not is_open_turn(turn.state):
            return
        if any(part.speech_state == "speaking" for part in turn.parts):
            turn.state = TurnState.OPEN_SPEAKING
            return
        if not _turn_has_text(turn):
            turn.state = TurnState.OPEN_EMPTY
            return
        if _turn_speakable_target_text(turn):
            turn.state = TurnState.OPEN_ACTIVE_UNSPOKEN
            return
        if any(part.speech_state == "spoken" for part in turn.parts):
            turn.state = TurnState.OPEN_SPOKEN_IDLE
            return
        turn.state = TurnState.OPEN_ACTIVE_UNSPOKEN

    async def _send_turn_update(
        self,
        *,
        reason: str,
        previous_turn: ConversationTurn | None = None,
        translation: dict[str, Any] | None = None,
    ) -> None:
        self._refresh_turn_state()
        payload = event(
            "turn_update",
            self.session_id,
            reason=reason,
            current_turn=self._turn_payload(self.current_turn),
            lanes={lane_id: self._lane_payload(lane) for lane_id, lane in self.lanes.items()},
        )
        if previous_turn is not None:
            payload["previous_turn"] = self._turn_payload(previous_turn)
        if translation is not None:
            payload["translation"] = translation
        await self._send(payload)

    def _close_asr_scope_for_turn(self, lane: ConversationLane) -> None:
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

    def _accept_visible_previews_for_parts(self, lane: ConversationLane, *, part_ids: set[str]) -> None:
        for part in self.current_turn.parts:
            if part.part_id not in part_ids:
                continue
            if part.source_preview_text:
                part.source_committed_text = _accepted_preview_text(
                    part.source_committed_text,
                    part.source_preview_text,
                )
                part.source_preview_text = ""
                lane.source_state.source_committed_text = part.source_committed_text
                lane.source_state.source_preview_text = ""
            if part.target_preview_text:
                part.target_committed_text = _accepted_preview_text(
                    part.target_committed_text,
                    part.target_preview_text,
                )
                part.target_preview_text = ""
                lane.translation_runner.target_state.target_committed_text = part.target_committed_text
                lane.translation_runner.target_state.target_preview_text = ""
                lane.last_target_committed = part.target_committed_text

    async def _pause_listening(self) -> None:
        self.listening = False
        await self._discard_runtime_work()
        SESSIONS.update(self.session_id, state="completed")
        await self._send(event("ended", self.session_id, reason="pause_listening"))
        with contextlib.suppress(Exception):
            await self.websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
        self.closed = True

    async def _discard_runtime_work(self) -> None:
        for lane in self.lanes.values():
            inflight = lane.asr_inflight
            if inflight is not None:
                sequence_id = self._sequence_from_request(inflight.job.request_id)
                lane.asr_runner.clear_inflight_work(sequence_id=sequence_id)
                self.asr_bridge.discard_request(inflight.job.request_id)
                lane.asr_inflight = None
            await _cancel_task(lane.translation_task)
            await _cancel_task(lane.tts_task)
            lane.translation_task = None
            lane.tts_task = None
            lane.pending_tts = None

    async def _cleanup(self) -> None:
        self.closed = True
        for lane in self.lanes.values():
            await _cancel_task(lane.translation_task)
            await _cancel_task(lane.tts_task)
            lane.translation_task = None
            lane.tts_task = None
        self.asr_bridge.stop_completion_stream()
        SESSIONS.close(self.session_id, reason="closed")

    async def _send(self, payload: dict[str, Any]) -> None:
        async with self.send_lock:
            await self.websocket.send_json(payload)

    def _current_lane(self) -> ConversationLane:
        return self.lanes[self.current_turn.lane_id]

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
        )

    def _build_asr_runner(self, *, asr_language: str | None) -> LiveASRRunner:
        return _build_live_asr_runner(
            sample_rate_hz=self.sample_rate_hz,
            channels=self.channels,
            sample_width_bytes=self.sample_width_bytes,
            asr_language=asr_language,
            live_settings=self.live_settings,
        )

    def _apply_live_runner_settings(self) -> None:
        settings = _live_asr_runner_settings(self.live_settings)
        for lane in self.lanes.values():
            lane.asr_runner.settings = settings
            lane.asr_runner.core.settings = settings.rolling

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

    def _turn_payload(self, turn: ConversationTurn) -> dict[str, Any]:
        lane = self.lanes[turn.lane_id]
        return {
            "turn_id": turn.turn_id,
            "lane_id": turn.lane_id,
            "direction": turn.direction,
            "state": turn.state.value,
            "source_language": lane.source_language,
            "target_language": lane.target_language,
            "source_text": _turn_source_text(turn),
            "target_text": _turn_target_text(turn),
            "speakable_target_text": _turn_speakable_target_text(turn),
            "can_speak_now": bool(_turn_speakable_target_text(turn)),
            "can_translate_now": bool(_turn_source_preview_text(turn) and turn.state != TurnState.OPEN_SPEAKING),
            "parts": [_part_payload(part) for part in turn.parts],
        }

    @staticmethod
    def _lane_payload(lane: ConversationLane) -> dict[str, Any]:
        return {
            "lane_id": lane.lane_id,
            "source_language": lane.source_language,
            "target_language": lane.target_language,
            "asr_language": lane.asr_language,
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


def warm_asr_vad() -> None:
    runner = _build_live_asr_runner(
        sample_rate_hz=get_int("live.audio.sample_rate_hz", 16000, min_value=8000),
        channels=get_int("live.audio.channels", 1, min_value=1),
        sample_width_bytes=2,
        asr_language=optional_str("live.asr.language"),
        live_settings=default_live_settings(),
    )
    runner.ensure_vad_ready()


def _build_live_asr_runner(
    *,
    sample_rate_hz: int,
    channels: int,
    sample_width_bytes: int,
    asr_language: str | None,
    live_settings: dict[str, Any] | None = None,
) -> LiveASRRunner:
    audio_format = AudioFormat(
        sample_rate_hz=int(sample_rate_hz),
        channels=int(channels),
        sample_width_bytes=int(sample_width_bytes),
    )
    return LiveASRRunner(
        audio_format=audio_format,
        settings=_live_asr_runner_settings(live_settings),
        language=asr_language,
    )


def _live_asr_runner_settings(live_settings: dict[str, Any] | None = None) -> LiveASRRunnerSettings:
    settings = live_settings if isinstance(live_settings, dict) else default_live_settings()
    return LiveASRRunnerSettings.from_live_config(live_runner_config(settings))


def _live_settings_asr_backend(live_settings: dict[str, Any] | None) -> str:
    if not isinstance(live_settings, dict):
        return ""
    asr = live_settings.get("asr")
    if not isinstance(asr, dict):
        return ""
    return str(asr.get("backend") or "")


def _tts_reference_wav_path(lane: ConversationLane) -> str | None:
    if not tts_uses_asr_reference_wav(lane.target_language):
        return None
    path = str(lane.last_asr_wav_path or "").strip()
    if not path:
        return None
    return path if Path(path).exists() else None


def _segment_span(segments: tuple[TranscriptSegment, ...]) -> tuple[int, int]:
    if not segments:
        return 0, 0
    start_ms = min(int(max(0, seg.t0_ms)) for seg in segments)
    end_ms = max(int(max(0, seg.t1_ms)) for seg in segments)
    return start_ms, max(start_ms, end_ms)


def _preview_start_ms(lane: ConversationLane) -> int:
    history = lane.asr_runner.preview_history
    source_t0_ms = int(max(0, int(getattr(history, "last_preview_source_t0_ms", 0) or 0)))
    return int(max(0, lane.asr_runner.processed_offset_ms, source_t0_ms))


def _preview_end_ms(lane: ConversationLane, *, fallback_t1_ms: int) -> int:
    preview = lane.asr_runner.transcript_state.preview
    end_ms = int(max(0, int(getattr(preview, "audio_end_ms", 0) or 0)))
    if end_ms <= 0:
        history = lane.asr_runner.preview_history
        end_ms = int(max(0, int(getattr(history, "last_preview_audio_end_fallback_ms", 0) or 0)))
    return int(max(fallback_t1_ms, end_ms))


def _asr_debug_for_interval(
    *,
    backend: str,
    request_id: str,
    segments: list[dict[str, Any]],
    speech_start_ms: int,
    speech_end_ms: int,
) -> dict[str, Any]:
    safe_start = int(max(0, speech_start_ms))
    safe_end = int(max(safe_start, speech_end_ms))
    selected = [
        segment
        for segment in segments
        if _segment_overlaps(segment, speech_start_ms=safe_start, speech_end_ms=safe_end)
    ]
    if not selected and segments:
        selected = list(segments)
    return {
        "backend": str(backend or ""),
        "request_id": str(request_id or ""),
        "segments": [_pc_segment_payload(segment) for segment in selected],
    }


def _segment_overlaps(segment: dict[str, Any], *, speech_start_ms: int, speech_end_ms: int) -> bool:
    try:
        segment_t0 = int(segment.get("t0_ms") or 0)
        segment_t1 = int(segment.get("t1_ms") or segment_t0)
    except Exception:
        return False
    if speech_end_ms <= speech_start_ms:
        return segment_t1 >= speech_start_ms
    return segment_t1 > speech_start_ms and segment_t0 < speech_end_ms


def _pc_segment_payload(segment: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "segment_id": str(segment.get("segment_id") or ""),
        "text": str(segment.get("text") or ""),
        "t0_ms": int(max(0, int(segment.get("t0_ms") or 0))),
        "t1_ms": int(max(0, int(segment.get("t1_ms") or 0))),
    }
    speaker = str(segment.get("speaker") or "")
    if speaker:
        payload["speaker"] = speaker
    debug = segment.get("asr_debug") if isinstance(segment.get("asr_debug"), dict) else {}
    for key, value in debug.items():
        payload[str(key)] = deepcopy(value)
    return payload


def _asr_event_text(lane: ConversationLane, *, kind: str, text: str) -> str:
    safe_text = _normalize_asr_visible_text(text)
    if str(kind or "").strip().lower() != "c" or not safe_text:
        return safe_text
    committed_text = str(lane.source_state.source_committed_text or "")
    return _with_boundary_space(committed_text, safe_text)


def _normalize_asr_visible_text(text: str) -> str:
    return " ".join(str(text or "").split())


def _with_boundary_space(left: str, right: str) -> str:
    left_text = str(left or "")
    right_text = str(right or "")
    if not left_text or not right_text:
        return right_text
    if not _needs_boundary_space(left_text, right_text):
        return right_text
    return f" {right_text}"


def _needs_boundary_space(left: str, right: str) -> bool:
    left_char = str(left or "")[-1:]
    right_char = str(right or "")[:1]
    if not left_char or not right_char:
        return False
    if left_char.isspace() or right_char.isspace():
        return False
    if right_char in ".,?!:;)]}%":
        return False
    if left_char in "([{":
        return False
    if _is_cjk(left_char) or _is_cjk(right_char):
        return False
    return True


def _is_cjk(char: str) -> bool:
    if not char:
        return False
    code = ord(char)
    return (
        0x3040 <= code <= 0x30FF
        or 0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0xAC00 <= code <= 0xD7AF
    )


def _part_payload(part: TurnPart) -> dict[str, Any]:
    return {
        "part_id": part.part_id,
        "speech_state": part.speech_state,
        "source_committed_text": part.source_committed_text,
        "source_preview_text": part.source_preview_text,
        "source_text": _part_source_text(part),
        "target_committed_text": part.target_committed_text,
        "target_preview_text": part.target_preview_text,
        "target_text": _part_target_text(part),
    }


def _visible_text(committed: str, preview: str) -> str:
    committed_text = str(committed or "").strip()
    preview_text = str(preview or "").strip()
    if not committed_text:
        return preview_text
    if not preview_text:
        return committed_text
    return f"{committed_text} {preview_text}"


def _accepted_preview_text(committed: str, preview: str) -> str:
    committed_text = str(committed or "").rstrip()
    preview_text = str(preview or "").strip()
    if not preview_text:
        return committed_text
    if not committed_text:
        return preview_text
    if preview_text.startswith(committed_text):
        return preview_text
    return _visible_text(committed_text, preview_text)


def _commit_event_text_for_preview(committed: str, preview: str) -> str:
    committed_text = str(committed or "").rstrip()
    accepted = _accepted_preview_text(committed_text, preview)
    if not committed_text:
        return accepted
    if accepted.startswith(committed_text):
        return accepted[len(committed_text) :]
    return accepted


def _part_source_text(part: TurnPart) -> str:
    return _visible_text(part.source_committed_text, part.source_preview_text)


def _part_target_text(part: TurnPart) -> str:
    return _visible_text(part.target_committed_text, part.target_preview_text)


def _turn_source_text(turn: ConversationTurn) -> str:
    return "\n\n".join(text for part in turn.parts if (text := _part_source_text(part)))


def _turn_target_text(turn: ConversationTurn) -> str:
    return "\n\n".join(text for part in turn.parts if (text := _part_target_text(part)))


def _turn_speakable_target_text(turn: ConversationTurn) -> str:
    return "\n\n".join(
        text
        for part in turn.parts
        if part.speech_state != "spoken" and (text := _part_target_text(part))
    )


def _turn_source_preview_text(turn: ConversationTurn) -> str:
    return "\n\n".join(
        text
        for part in turn.parts
        if part.speech_state != "spoken" and (text := str(part.source_preview_text or "").strip())
    )


def _turn_has_text(turn: ConversationTurn) -> bool:
    return bool(_turn_source_text(turn) or _turn_target_text(turn))
