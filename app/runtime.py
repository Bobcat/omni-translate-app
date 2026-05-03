from __future__ import annotations

import asyncio
import contextlib
import time
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
from app.config import get_bool, get_float, get_int, get_str, optional_str
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


class ConversationRuntime:
    def __init__(self, *, websocket: WebSocket, session: ConversationSession) -> None:
        self.websocket = websocket
        self.session = session
        self.session_id = session.session_id
        self.sample_rate_hz = get_int("live.audio.sample_rate_hz", 16000, min_value=8000)
        self.channels = get_int("live.audio.channels", 1, min_value=1)
        self.sample_width_bytes = 2
        self.asr_language = optional_str("live.asr.language") or _asr_language_for(session.source_language)
        self.asr_runner = self._build_asr_runner()
        self.asr_bridge = LiveASRPoolBridge(
            session_id=self.session_id,
            sample_rate_hz=self.sample_rate_hz,
            channels=self.channels,
        )
        self.translation_runner = self._build_translation_runner()
        self.translation_bridge = TranslationBridge(
            source_language=session.source_language,
            target_language=session.target_language,
        )
        self.tts_bridge = TTSBridge()
        self.source_state = SourceTranscriptState()
        self.asr_ready: asyncio.Event | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.asr_inflight: ASRJob | None = None
        self.translation_task: asyncio.Task[Any] | None = None
        self.send_lock = asyncio.Lock()
        self.listening = False
        self.closed = False
        self.source_revision = 0
        self.target_revision = 0
        self.last_target_committed = ""
        self.line_number = 0

    async def run(self) -> None:
        await self.websocket.accept()
        self.loop = asyncio.get_running_loop()
        self.asr_ready = asyncio.Event()
        try:
            self.asr_runner.ensure_vad_ready()
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
                source_language=self.session.source_language,
                target_language=self.session.target_language,
                asr_language=self.asr_language,
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
        if msg_type == "speak_now":
            await self._speak_now()
            return True
        if msg_type == "set_direction":
            await self._set_direction(
                source_language=payload.get("source_language"),
                target_language=payload.get("target_language"),
            )
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
        self.asr_runner.ingest_audio(raw)
        await self._process_asr(force=False)

    async def _process_asr(self, *, force: bool) -> None:
        await self._poll_asr()
        await self._enqueue_asr(force=force)

    async def _poll_asr(self) -> None:
        job = self.asr_inflight
        if job is None:
            return
        if not self.asr_bridge.has_terminal_result(job.request_id):
            return
        result = await asyncio.to_thread(
            self.asr_bridge.take_terminal_result,
            job.request_id,
            t0_offset_ms=job.t0_ms,
        )
        if not result.done:
            return
        if result.ok:
            apply = self.asr_runner.apply_result(
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
            if apply.reason == "commit_applied" and apply.committed_segments:
                text = " ".join(seg.text.strip() for seg in apply.committed_segments if seg.text.strip()).strip()
                if text:
                    await self._source_event(kind="c", text=text)
            preview_text = str(apply.preview.text or "").strip()
            if apply.reason in {"preview_applied", "commit_applied"} and preview_text:
                await self._source_event(kind="p", text=preview_text)
        else:
            self.asr_runner.apply_result(
                ASRResult(
                    sequence_id=self._sequence_from_request(job.request_id),
                    t0_ms=job.t0_ms,
                    t1_ms=job.t1_ms,
                    ok=False,
                    error=result.error,
                )
            )
            await self._send(event("error", self.session_id, code="asr_error", message=result.error))
        self.asr_inflight = None

    async def _enqueue_asr(self, *, force: bool) -> None:
        if self.asr_inflight is not None:
            return
        if not self.listening and not force:
            return
        decision = self.asr_runner.maybe_dispatch_work(now_mono=time.monotonic(), force=force)
        if decision.error:
            await self._send(event("error", self.session_id, code="asr_dispatch_error", message=decision.error))
            return
        if decision.speech_gate_decision is not None and decision.speech_gate_decision.force_commit_requested:
            await self._commit_preview_tail(speech_gate_forced=True)
        work = decision.work_decision.work_item
        if work is None:
            return
        try:
            job = await asyncio.to_thread(
                self.asr_bridge.enqueue_pcm16,
                chunk_index=work.sequence_id,
                t0_ms=work.t0_ms,
                t1_ms=work.t1_ms,
                pcm16le=work.pcm16le,
                language=self.asr_language,
            )
        except Exception as exc:
            self.asr_runner.rollback_inflight_work(sequence_id=work.sequence_id)
            await self._send(event("error", self.session_id, code="asr_submit_failed", message=str(exc)))
            return
        self.asr_inflight = job
        await self._send(event("asr_status", self.session_id, state="inflight"))

    async def _commit_preview_tail(self, *, speech_gate_forced: bool = False) -> None:
        segment = self.asr_runner.commit_preview_tail(speech_gate_forced=speech_gate_forced)
        if segment is None:
            return
        text = str(segment.text or "").strip()
        if text:
            await self._source_event(kind="c", text=text)

    async def _speak_now(self) -> None:
        decision = self.asr_runner.manual_commit_preview()
        retired_ids = {int(seq) for seq in decision.retired_sequence_ids}
        if retired_ids:
            job = self.asr_inflight
            if job is not None and self._sequence_from_request(job.request_id) in retired_ids:
                self.asr_bridge.discard_request(job.request_id)
                self.asr_inflight = None

        segment = decision.segment
        text = str(segment.text or "").strip() if segment is not None else ""
        if decision.applied and text:
            await self._source_event(kind="c", text=text)
            await self._send(
                event(
                    "asr_status",
                    self.session_id,
                    state="manual_commit",
                    reason=decision.commit_reason,
                    retired_sequence_ids=sorted(retired_ids),
                    restart_t0_ms=decision.restart_t0_ms,
                )
            )
            await self._enqueue_asr(force=True)
            return

        await self._send(
            event(
                "asr_status",
                self.session_id,
                state="manual_commit_skipped",
                reason=decision.reason,
            )
        )

    async def _set_direction(self, *, source_language: Any, target_language: Any) -> None:
        next_source = str(source_language or "").strip()
        next_target = str(target_language or "").strip()
        if not next_source or not next_target:
            await self._send(
                event(
                    "error",
                    self.session_id,
                    code="invalid_direction",
                    message="source_language and target_language are required",
                )
            )
            return

        if self.translation_task is not None and not self.translation_task.done():
            self.translation_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.translation_task
        self.translation_task = None

        if self.asr_inflight is not None:
            self.asr_bridge.discard_request(self.asr_inflight.request_id)
            self.asr_inflight = None
        ready = self.asr_ready
        if ready is not None:
            ready.clear()
        self.asr_bridge.advance_generation()

        self.session.source_language = next_source
        self.session.target_language = next_target
        self.asr_language = optional_str("live.asr.language") or _asr_language_for(next_source)
        self.asr_runner = self._build_asr_runner()
        self.asr_runner.ensure_vad_ready()
        self.translation_runner = self._build_translation_runner()
        self.translation_bridge = TranslationBridge(
            source_language=next_source,
            target_language=next_target,
        )
        self.source_state = SourceTranscriptState()
        self.source_revision += 1
        self.target_revision += 1
        self.last_target_committed = ""
        self.line_number = 0

        SESSIONS.update(
            self.session_id,
            source_language=next_source,
            target_language=next_target,
            source_revision=self.source_revision,
            target_revision=self.target_revision,
            source_committed_text="",
            target_committed_text="",
            state="listening" if self.listening else "connected",
        )
        await self._send(
            event(
                "source_update",
                self.session_id,
                reset=True,
                committed_append="",
                preview="",
                source_revision=self.source_revision,
            )
        )
        await self._send(
            event(
                "target_update",
                self.session_id,
                reset=True,
                committed_append="",
                preview="",
                target_revision=self.target_revision,
                reason="direction_changed",
            )
        )
        await self._send(
            event(
                "direction_changed",
                self.session_id,
                source_language=next_source,
                target_language=next_target,
                asr_language=self.asr_language,
            )
        )

    async def _source_event(self, *, kind: str, text: str) -> None:
        self.line_number += 1
        source_event = SourceEvent(kind=kind, text=text, line_number=self.line_number)
        self.source_state.apply_event(source_event)
        self.source_revision += 1

        if kind == "c":
            await self._send(
                event(
                    "source_update",
                    self.session_id,
                    reset=False,
                    committed_append=text,
                    preview="",
                    source_revision=self.source_revision,
                )
            )
            SESSIONS.update(
                self.session_id,
                source_revision=self.source_revision,
                source_committed_text=self.source_state.source_committed_text,
            )
        else:
            await self._send(
                event(
                    "source_update",
                    self.session_id,
                    reset=False,
                    committed_append="",
                    preview=self.source_state.source_preview_text,
                    source_revision=self.source_revision,
                )
            )

        step = self.translation_runner.on_source_event(source_event, self.source_state)
        if step.dispatch_request is not None:
            self._schedule_translation(step.dispatch_request)

    def _schedule_translation(self, request: LiveDispatchRequest) -> None:
        if self.translation_task is not None and not self.translation_task.done():
            return
        self.translation_task = asyncio.create_task(self._run_translation(request))

    async def _run_translation(self, request: LiveDispatchRequest) -> None:
        try:
            translation = await asyncio.to_thread(self.translation_bridge.run, request)
            step = self.translation_runner.on_llm_result(request, translation.text)
        except Exception as exc:
            await self._send(event("error", self.session_id, code="translation_failed", message=str(exc)))
            return

        target_state = self.translation_runner.target_state
        committed = str(target_state.target_committed_text or "")
        reset = not committed.startswith(self.last_target_committed)
        committed_append = committed if reset else committed[len(self.last_target_committed) :]
        self.last_target_committed = committed
        if step.result_applied:
            self.target_revision += 1

        tts_payload = None
        tts_error = ""
        if committed_append.strip() and self.tts_bridge.enabled:
            try:
                tts_payload = await asyncio.to_thread(
                    self.tts_bridge.synthesize,
                    session_id=self.session_id,
                    text=committed_append,
                    language=self.session.target_language,
                )
                SESSIONS.add_artifact(self.session_id, tts_payload)
            except Exception as exc:
                tts_error = str(exc)

        await self._send(
            event(
                "target_update",
                self.session_id,
                reset=reset,
                committed_append=committed_append,
                preview=str(target_state.target_preview_text or ""),
                target_revision=self.target_revision,
                reason=step.reason,
                wall_ms=round(float(translation.wall_ms), 1),
                model=translation.model,
                tts=tts_payload,
                tts_error=tts_error,
            )
        )
        SESSIONS.update(
            self.session_id,
            target_revision=self.target_revision,
            target_committed_text=committed,
        )
        if step.dispatch_request is not None:
            self.translation_task = None
            self._schedule_translation(step.dispatch_request)

    async def _pause_listening(self) -> None:
        self.listening = False
        SESSIONS.update(self.session_id, state="finalizing")
        await self._send(event("state", self.session_id, state="finalizing"))
        self.asr_runner.finalize_input()
        await self._process_asr(force=True)
        deadline = time.monotonic() + get_float("live.timing.drain_wait_s", 20.0, min_value=0.0)
        while self.asr_inflight is not None and time.monotonic() < deadline:
            await self._poll_asr()
            if self.asr_inflight is None:
                break
            ready = self.asr_ready
            timeout = min(0.1, max(0.0, deadline - time.monotonic()))
            if ready is not None:
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(ready.wait(), timeout=timeout)
                    ready.clear()
            else:
                await asyncio.sleep(timeout)
        await self._commit_preview_tail()
        if self.translation_task is not None and not self.translation_task.done():
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.translation_task, timeout=30.0)
        SESSIONS.update(self.session_id, state="completed")
        await self._send(event("ended", self.session_id, reason="pause_listening"))
        with contextlib.suppress(Exception):
            await self.websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
        self.closed = True

    async def _cleanup(self) -> None:
        self.closed = True
        if self.translation_task is not None and not self.translation_task.done():
            self.translation_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.translation_task
        self.asr_bridge.stop_completion_stream()
        SESSIONS.close(self.session_id, reason="closed")

    async def _send(self, payload: dict[str, Any]) -> None:
        async with self.send_lock:
            await self.websocket.send_json(payload)

    def _build_asr_runner(self) -> LiveASRRunner:
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
        return LiveASRRunner(audio_format=audio_format, settings=settings, language=self.asr_language)

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
