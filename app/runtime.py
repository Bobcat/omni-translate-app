from __future__ import annotations

import asyncio
import time
from copy import deepcopy
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from fastapi import WebSocket
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
from app.config import get_bool, get_float, get_int, get_str, optional_str
from app.live_metrics import log_event as _metric
from app.live_settings import default_live_settings
from app.live_settings import live_runner_config
from app.live_settings import merge_live_settings
from app.live_settings import normalize_live_settings_delta
from app.protocol import event
from app.sessions import ConversationSession
from app.sessions import SESSIONS
from app.translation_bridge import TranslationBridge
from app.tts_bridge import tts_settings_enabled
from app.tts_bridge import tts_settings_snapshot
from app.tts_bridge import tts_supports_voice_cloning
from app.voice.cloning import normalize_voice_cloning_settings
from app.voice.cloning import VoiceCloningWindow
from app.voice.session_lifecycle import ConversationLifecycle
from app.voice.session_storage import SessionArtifactLimitExceeded
from app.voice.tasks import cancel_task
from app.voice.tts_delivery import TtsDelivery


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


# Characters that end a sentence across the languages we offer. Used to
# decide when an ASR commit closes the current bubble. Wider than the
# engine-internal ASCII-only check; covers CJK, fullwidth Latin, Arabic
# question mark, and Devanagari danda. Ellipsis and em-dash are
# intentionally excluded (trailing-off / interruption, not closure).
SENTENCE_END_CHARS = ".?!。？！．؟।॥"

# Hard cap on how long a single bubble may stay open (wall-clock
# seconds of bubble lifetime). Fairness ceiling, not UX heuristic;
# expected to fire only in long monologues without sentence-boundary
# or silence-gate cues. Starting value is intentionally low for
# testing.
BUBBLE_CLOSE_MAX_DURATION_S = 3.0


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
    # True when the TTS for this part had to fall back to a sub-threshold
    # last_speech fragment (no previous qualifying fragment available).
    # Surfaced to the UI as an "uncertain voice quality" indicator.
    low_quality_reference: bool = False
    # True once the bubble was closed by the segmentation logic. Closed
    # parts no longer accept new ASR text — the next event opens a fresh
    # part. Separate from speech_state so close and TTS lifecycle don't
    # entangle.
    is_closed: bool = False
    # time.monotonic() snapshot taken when the part was first created.
    # Used by the duration-cap layer to decide when to close the bubble.
    bubble_opened_mono: float = 0.0


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
    submitted_mono: float = 0.0


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
    # In-flight TTS clips keyed by artifact_id. Each entry is awaiting
    # frontend playback completion. Allowed to hold multiple entries at
    # once so the turn-level Speak orchestrator can pipeline pool calls
    # — the next bubble's synth can run while the previous bubble's WAV
    # is still being played in the browser.
    pending_tts: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_asr_segments: list[dict[str, Any]] = field(default_factory=list)
    last_asr_request_id: str = ""
    last_asr_backend: str = ""
    last_asr_wav_path: str = ""
    # Most recent ASR wav whose quality score met the threshold; used as the
    # preferred reference for last_speech TTS when the current fragment is
    # too short / silence-heavy to be a usable voice reference.
    last_qualifying_asr_wav_path: str = ""


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
        self.tts_fairness_key = session.tts_fairness_key
        self.live_settings = merge_live_settings(default_live_settings(), session.live_settings or {})
        self.tts_settings = dict(session.tts_settings or tts_settings_snapshot()[0])
        self.asr_bridge = LiveASRPoolBridge(
            session_id=self.session_id,
            sample_rate_hz=self.sample_rate_hz,
            channels=self.channels,
            live_settings=self.live_settings,
        )
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
        self.voice_cloning_settings = dict(session.voice_cloning or {"enabled": False})
        self.voice_cloning = VoiceCloningWindow(
            session_id=self.session_id,
            lane_ids=tuple(self.lanes),
        )
        self.voice_cloning.set_enabled(bool(self.voice_cloning_settings.get("enabled")))
        self.turn_counter = 1
        self.current_turn = self._new_turn(lane_id="a_to_b")
        self.closed_turns: list[ConversationTurn] = []
        self.lifecycle = ConversationLifecycle(self)
        self.tts_delivery = TtsDelivery(self, part_target_text=_part_target_text)

    async def run(self) -> None:
        await self.lifecycle.run()

    async def _handle_control(self, raw_text: str) -> bool:
        import json

        try:
            payload = json.loads(raw_text)
        except Exception:
            await self.lifecycle.send(event("error", self.session_id, code="invalid_json", message="Invalid control message."))
            return True
        msg_type = str(payload.get("type") or "").strip().lower()
        if msg_type == "start_listening":
            self.lifecycle.listening = True
            SESSIONS.update(self.session_id, state="listening")
            await self.lifecycle.send(event("state", self.session_id, state="listening"))
            return True
        if msg_type == "pause_listening":
            await self.lifecycle.pause_listening()
            return False
        if msg_type == "next_turn":
            await self._next_turn(lane_id=payload.get("lane_id"))
            return True
        if msg_type == "speak_now":
            await self._speak_now()
            return True
        if msg_type == "speak_part":
            await self._speak_part(payload.get("part_id"))
            return True
        if msg_type == "translate_now":
            await self._translate_now()
            return True
        if msg_type == "discard_inflight":
            self._discard_inflight()
            return True
        if msg_type == "replay_tts":
            await self.tts_delivery.replay(payload)
            return True
        if msg_type == "stop_tts":
            await self.tts_delivery.stop(payload)
            return True
        if msg_type == "update_live_settings":
            await self._update_live_settings(payload)
            return True
        if msg_type == "update_tts_settings":
            await self._update_tts_settings(payload)
            return True
        if msg_type == "update_voice_cloning":
            await self._update_voice_cloning(payload)
            return True
        if msg_type == "tts_playback_complete":
            await self.tts_delivery.playback_complete(payload)
            return True
        await self.lifecycle.send(event("error", self.session_id, code="unsupported_control", message=msg_type))
        return True

    async def _update_live_settings(self, payload: dict[str, Any]) -> None:
        delta, errors = normalize_live_settings_delta(payload.get("settings"), live_update=True)
        if errors:
            await self.lifecycle.send(
                event(
                    "error",
                    self.session_id,
                    code="invalid_live_settings",
                    message="; ".join(errors),
                )
            )
            return
        if not delta:
            await self.lifecycle.send(event("live_settings", self.session_id, live_settings=deepcopy(self.live_settings)))
            return
        self.live_settings = merge_live_settings(self.live_settings, delta)
        self.asr_bridge.live_settings = self.live_settings
        self._apply_live_runner_settings()
        await self.lifecycle.send(event("live_settings", self.session_id, live_settings=deepcopy(self.live_settings)))

    async def _update_tts_settings(self, payload: dict[str, Any]) -> None:
        settings, errors = tts_settings_snapshot(payload.get("settings"))
        if errors:
            await self.lifecycle.send(
                event(
                    "error",
                    self.session_id,
                    code="invalid_tts_settings",
                    message="; ".join(f"{key}: {value}" for key, value in errors.items()),
                )
            )
            return
        if self.voice_cloning.enabled and not tts_supports_voice_cloning(settings):
            await self.lifecycle.send(
                event(
                    "error",
                    self.session_id,
                    code="invalid_tts_settings",
                    message="Active speaker voice cloning requires the VoxCPM TTS backend",
                )
            )
            return
        previous = self.tts_settings
        self.tts_settings = settings
        await self.tts_delivery.settings_changed(previous, settings)
        SESSIONS.update(self.session_id, tts_settings=deepcopy(settings))
        await self.lifecycle.send(
            event(
                "tts_settings",
                self.session_id,
                tts_settings=deepcopy(settings),
            )
        )

    async def _update_voice_cloning(self, payload: dict[str, Any]) -> None:
        settings, errors = normalize_voice_cloning_settings(
            payload.get("settings"),
            supported=tts_supports_voice_cloning(self.tts_settings),
        )
        if errors:
            await self.lifecycle.send(
                event(
                    "error",
                    self.session_id,
                    code="invalid_voice_cloning_settings",
                    message="; ".join(f"{key}: {value}" for key, value in errors.items()),
                )
            )
            return
        previous_enabled = bool(self.voice_cloning_settings.get("enabled"))
        enabled = bool(settings.get("enabled"))
        self.voice_cloning_settings = settings
        self.voice_cloning.set_enabled(enabled)
        if previous_enabled != enabled:
            _metric(
                "voice_cloning_setting",
                sess=self.session_id,
                enabled=enabled,
            )
        SESSIONS.update(self.session_id, voice_cloning=deepcopy(settings))
        await self._send_voice_cloning_status()

    async def _handle_audio(self, raw_bytes: bytes) -> None:
        if not self.lifecycle.listening:
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
        _metric(
            "asr_done",
            sess=self.session_id,
            lane=lane.lane_id,
            rid=str(job.request_id),
            wall_ms=round((time.monotonic() - float(inflight.submitted_mono or time.monotonic())) * 1000.0, 2),
            ok=bool(result.ok),
            segs=len(result.segments or []) if result.ok else 0,
        )

        is_current_turn = inflight.turn_id == self.current_turn.turn_id
        if result.ok:
            result_segments = [dict(seg) for seg in (result.segments or []) if isinstance(seg, dict)]
            result_backend = str(result.asr_backend or _live_settings_asr_backend(self.live_settings))
            lane.last_asr_segments = list(result_segments)
            lane.last_asr_request_id = str(result.request_id or job.request_id)
            lane.last_asr_backend = result_backend
            lane.last_asr_wav_path = str(job.wav_path)
            self.tts_delivery.record_asr_reference(lane)
            previous_reference = self.voice_cloning.reference(lane.lane_id)
            try:
                reference_changed = await asyncio.to_thread(
                    self.voice_cloning.record_asr_result,
                    lane_id=lane.lane_id,
                    request_id=str(result.request_id or job.request_id),
                    wav_path=str(job.wav_path),
                    wav_t0_ms=job.t0_ms,
                    wav_t1_ms=job.t1_ms,
                    segments=result_segments,
                )
            except SessionArtifactLimitExceeded as exc:
                lane.asr_inflight = None
                await self.lifecycle.end_for_storage_limit(limit_bytes=exc.limit_bytes)
                return
            except (OSError, ValueError):
                reference_changed = False
                _metric(
                    "voice_cloning_reference",
                    sess=self.session_id,
                    lane=lane.lane_id,
                    state="rejected",
                    reason="materialization_failed",
                )
            if reference_changed:
                reference = self.voice_cloning.reference(lane.lane_id)
                await self._send_voice_cloning_status(lane_id=lane.lane_id)
                _metric(
                    "voice_cloning_reference",
                    sess=self.session_id,
                    lane=lane.lane_id,
                    state="ready",
                    first=previous_reference is None,
                    duration_ms=int(reference.duration_ms if reference else 0),
                    segments=int(reference.segment_count if reference else 0),
                )
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
            await self.lifecycle.send(
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
        if not self.lifecycle.listening and not force:
            return
        _vad_t0 = time.monotonic()
        decision = lane.asr_runner.maybe_dispatch_work(now_mono=_vad_t0, force=force)
        _vad_ms = (time.monotonic() - _vad_t0) * 1000.0
        _gate = decision.speech_gate_decision
        _metric(
            "vad",
            sess=self.session_id,
            lane=lane.lane_id,
            ms=round(_vad_ms, 2),
            dec=str(getattr(_gate, "next_state", "") or ""),
            speech=bool(getattr(_gate, "speech_hit", False)) if _gate else False,
            force_commit=bool(getattr(_gate, "force_commit_requested", False)) if _gate else False,
        )
        await self._send_vad_state(lane, decision)
        if decision.error:
            await self.lifecycle.send(
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
            await self._close_current_bubble(lane, reason="vad_silence")
        work = decision.work_decision.work_item
        if work is None:
            return
        _submit_t0 = time.monotonic()
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
        except SessionArtifactLimitExceeded as exc:
            lane.asr_runner.rollback_inflight_work(sequence_id=work.sequence_id)
            await self.lifecycle.end_for_storage_limit(limit_bytes=exc.limit_bytes)
            return
        except Exception as exc:
            lane.asr_runner.rollback_inflight_work(sequence_id=work.sequence_id)
            await self.lifecycle.send(
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
        lane.asr_inflight = LaneASRJob(
            job=job,
            turn_id=self.current_turn.turn_id,
            submitted_mono=_submit_t0,
        )
        _metric(
            "asr_submit",
            sess=self.session_id,
            lane=lane.lane_id,
            rid=str(job.request_id),
            t0=int(work.t0_ms),
            t1=int(work.t1_ms),
            audio_ms=int(work.t1_ms - work.t0_ms),
            submit_ms=round((time.monotonic() - _submit_t0) * 1000.0, 2),
        )
        await self.lifecycle.send(
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
        await self.lifecycle.send(
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
            await self.lifecycle.send(
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
        await self._send_voice_cloning_status(lane_id=next_lane_id)

    async def _speak_now(self) -> None:
        turn = self.current_turn
        speaking_part_ids = [
            part.part_id
            for part in turn.parts
            if part.speech_state != "spoken" and _part_target_text(part)
        ]
        await self._dispatch_speak_sequence(speaking_part_ids, reason="speak_now")

    async def _speak_part(self, part_id: Any) -> None:
        normalized = str(part_id or "").strip()
        if not normalized:
            return
        turn = self.current_turn
        target = next((p for p in turn.parts if p.part_id == normalized), None)
        if target is None or target.speech_state == "spoken" or not _part_target_text(target):
            return
        await self._dispatch_speak_sequence([normalized], reason="speak_part")

    async def _dispatch_speak_sequence(self, speaking_part_ids: list[str], *, reason: str) -> None:
        lane = self._current_lane()
        turn = self.current_turn
        if turn.state == TurnState.OPEN_SPEAKING or lane.tts_task is not None:
            await self.lifecycle.send(
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
        if not speaking_part_ids:
            await self.lifecycle.send(
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
        if not tts_settings_enabled(self.tts_settings):
            await self.lifecycle.send(
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
        if self.voice_cloning.enabled and self.voice_cloning.reference(lane.lane_id) is None:
            _metric(
                "voice_cloning_tts_skip",
                sess=self.session_id,
                lane=lane.lane_id,
                trigger=reason,
            )
            if reason in {"speak_now", "speak_part"}:
                await self.lifecycle.send(
                    event(
                        "tts_status",
                        self.session_id,
                        state="skipped",
                        reason="voice_clone_preparing",
                        lane_id=lane.lane_id,
                        turn_id=turn.turn_id,
                        message="Speak naturally for a few more seconds before using voice cloning",
                    )
                )
            return
        if reason in {"speak_now", "speak_part"}:
            self.tts_delivery.reset_speculation_budget(reason=reason)
        selection = set(speaking_part_ids)
        self._close_asr_scope_for_turn(lane)
        self._accept_visible_previews_for_parts(lane, part_ids=selection)
        for part in turn.parts:
            if part.part_id in selection:
                part.speech_state = "speaking"
        self._refresh_turn_state()
        await self._send_turn_update(reason=reason)
        lane.tts_task = asyncio.create_task(
            self.tts_delivery.run_speak_sequence(
                lane.lane_id,
                turn.turn_id,
                list(speaking_part_ids),
                generation_reason="automatic" if reason == "auto_speak" else "demand",
            )
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
            self._schedule_translation(lane, step.dispatch_request, turn_id=turn_id, part_id=part.part_id)

        if kind == "c":
            close_reason = self._bubble_close_reason(part)
            if close_reason is not None:
                await self._close_current_bubble(lane, reason=close_reason)

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
        await cancel_task(lane.translation_task)
        lane.translation_task = None
        lane.translation_runner.retire_inflight()

    async def _send_translation_status(self, *, state: str, reason: str, message: str) -> None:
        lane = self._current_lane()
        await self.lifecycle.send(
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

    def _schedule_translation(
        self,
        lane: ConversationLane,
        request: LiveDispatchRequest,
        *,
        turn_id: str,
        part_id: str,
    ) -> None:
        if lane.translation_task is not None and not lane.translation_task.done():
            return
        lane.translation_task = asyncio.create_task(
            self._run_translation(lane.lane_id, turn_id, part_id, request, lane.translation_generation)
        )

    async def _run_translation(
        self,
        lane_id: str,
        turn_id: str,
        part_id: str,
        request: LiveDispatchRequest,
        generation: int,
    ) -> None:
        lane = self.lanes[lane_id]
        current_task = asyncio.current_task()
        _xlate_t0 = time.monotonic()
        _metric(
            "xlate_submit",
            sess=self.session_id,
            lane=lane_id,
            part=part_id,
            src_chars=len(str(getattr(request.opportunity, "source_window", "") or "")),
        )
        try:
            translation = await asyncio.to_thread(lane.translation_bridge.run, request)
            _metric(
                "xlate_done",
                sess=self.session_id,
                lane=lane_id,
                part=part_id,
                wall_ms=round((time.monotonic() - _xlate_t0) * 1000.0, 2),
                ok=True,
                profile=str(getattr(translation, "profile", "") or ""),
            )
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
            _metric(
                "xlate_done",
                sess=self.session_id,
                lane=lane_id,
                part=part_id,
                wall_ms=round((time.monotonic() - _xlate_t0) * 1000.0, 2),
                ok=False,
                err=str(exc)[:200],
            )
            await self.lifecycle.send(
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

        part = next((p for p in self.current_turn.parts if p.part_id == part_id), None)
        if part is None:
            return
        part.target_committed_text = committed
        part.target_preview_text = str(target_state.target_preview_text or "")
        self._refresh_turn_state()
        await self._send_turn_update(
            reason="translation_update",
            translation={
                "reason": step.reason,
                "wall_ms": round(float(translation.wall_ms), 1),
                "profile": translation.profile,
                "quality": translation.quality,
            },
        )
        if step.dispatch_request is not None:
            self._schedule_translation(lane, step.dispatch_request, turn_id=turn_id, part_id=part_id)

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
        self.tts_delivery.discard_turn(turn.turn_id)
        self._close_asr_scope_for_turn(lane)
        await cancel_task(lane.translation_task)
        await cancel_task(lane.tts_task)
        lane.translation_task = None
        lane.tts_task = None
        lane.pending_tts.clear()
        turn.state = TurnState.CLOSED
        self.closed_turns.append(turn)
        self.turn_counter += 1
        return turn

    def _reset_lane_text_scope(self, lane: ConversationLane) -> None:
        # NB: deliberately does NOT touch lane.pending_tts. TTS lifecycle
        # (synthesis in-flight, awaiting playback complete) is orthogonal
        # to the lane's ASR/translation text state, which is what this
        # helper resets. The bubble-close path uses this between bubbles
        # while earlier-bubble TTS may still be playing.
        lane.source_state = SourceTranscriptState()
        lane.translation_runner = self._build_translation_runner()
        lane.translation_generation += 1
        lane.last_target_committed = ""
        lane.line_number = 0

    def _current_writable_part(self) -> TurnPart:
        turn = self.current_turn
        last = turn.parts[-1] if turn.parts else None
        if last is None or last.speech_state == "spoken" or last.is_closed:
            new_part = TurnPart(
                part_id=f"{turn.turn_id}_part_{len(turn.parts) + 1}",
                bubble_opened_mono=time.monotonic(),
            )
            turn.parts.append(new_part)
            return new_part
        return last

    def _bubble_close_reason(self, part: TurnPart) -> str | None:
        # Decide whether the just-updated bubble should close. Heuristic
        # layer first (sentence boundary), then hard cap (duration).
        # Empty / already-closed parts never trigger; the close helper is
        # also idempotent as a second line of defence.
        if part.is_closed:
            return None
        committed = str(part.source_committed_text or "").rstrip()
        if not committed:
            return None
        if committed[-1] in SENTENCE_END_CHARS:
            return "sentence_boundary"
        if (
            part.bubble_opened_mono > 0.0
            and (time.monotonic() - part.bubble_opened_mono) >= BUBBLE_CLOSE_MAX_DURATION_S
        ):
            return "max_duration"
        return None

    async def _close_current_bubble(self, lane: ConversationLane, *, reason: str) -> None:
        # Mark the current bubble as closed and reset the lane's text
        # scope so the next ASR event opens a fresh part with empty
        # translation context. Drains in-flight translation first so its
        # result lands on the bubble being closed, not on the next one.
        turn = self.current_turn
        if not turn.parts:
            return
        part = turn.parts[-1]
        if part.is_closed:
            return
        if not part.source_committed_text and not part.source_preview_text:
            return
        pending = lane.translation_task
        if pending is not None and not pending.done():
            try:
                await pending
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
        part.is_closed = True
        self._reset_lane_text_scope(lane)
        self._refresh_turn_state()
        await self._send_turn_update(reason=f"bubble_close:{reason}")
        if not _part_target_text(part):
            return
        if self.tts_delivery.auto_speak_enabled:
            await self._dispatch_speak_sequence([part.part_id], reason="auto_speak")
            return
        self.tts_delivery.prepare_definitive_part(
            lane_id=lane.lane_id,
            turn_id=turn.turn_id,
            part_id=part.part_id,
        )

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
        await self.lifecycle.send(payload)

    async def _send_voice_cloning_status(self, *, lane_id: str | None = None) -> None:
        lane_ids = [lane_id] if lane_id in self.lanes else list(self.lanes)
        for current_lane_id in lane_ids:
            await self.lifecycle.send(
                event(
                    "voice_cloning_status",
                    self.session_id,
                    **self.voice_cloning.status_payload(current_lane_id),
                )
            )

    def _discard_inflight(self) -> None:
        # Frontend sends this when the user stops the mic so the server
        # drops any audio/ASR work already in flight; without it the ASR
        # pipeline keeps producing commits from buffered audio and an
        # "extra bubble" appears after the user thought they stopped.
        if self.current_turn.state == TurnState.OPEN_SPEAKING:
            return
        lane = self._current_lane()
        self._close_asr_scope_for_turn(lane)

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
                quality=get_str("translation.quality", "fast"),
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
        "low_quality_reference": bool(part.low_quality_reference),
        "is_closed": bool(part.is_closed),
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
