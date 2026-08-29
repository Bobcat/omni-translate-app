"""Connection and resource lifecycle for one realtime voice session."""
from __future__ import annotations

import asyncio
import contextlib
from copy import deepcopy
from typing import TYPE_CHECKING, Any

from fastapi import status

from app.config import get_int
from app.protocol import event
from app.sessions import SESSIONS
from app.voice.session_storage import release_session_artifact_tracking
from app.voice.tasks import cancel_task

if TYPE_CHECKING:
    from app.runtime import ConversationRuntime


class ConversationLifecycle:
    def __init__(self, runtime: ConversationRuntime) -> None:
        self.runtime = runtime
        self.asr_ready: asyncio.Event | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.send_lock = asyncio.Lock()
        self.listening = False
        self.closed = False
        self.close_reason = "closed"
        self.max_duration_s = get_int(
            "live.max_session_duration_s",
            900,
            min_value=60,
        )
        self.deadline_mono: float | None = None

    async def run(self) -> None:
        runtime = self.runtime
        self.loop = asyncio.get_running_loop()
        self.asr_ready = asyncio.Event()
        try:
            await runtime.websocket.accept()
            self.deadline_mono = self.loop.time() + self.max_duration_s
            try:
                for lane in runtime.lanes.values():
                    lane.asr_runner.ensure_vad_ready()
            except Exception as exc:
                await self.send(
                    event(
                        "error",
                        runtime.session_id,
                        code="vad_init_failed",
                        message=str(exc),
                        fatal=True,
                    )
                )
                await runtime.websocket.close(
                    code=status.WS_1011_INTERNAL_ERROR,
                    reason="vad_init_failed",
                )
                return

            runtime.asr_bridge.start_completion_stream(
                on_terminal_event=self.notify_asr_ready
            )
            await self.send(
                event(
                    "ready",
                    runtime.session_id,
                    audio_input={
                        "format": "pcm16le",
                        "sample_rate_hz": runtime.sample_rate_hz,
                        "channels": runtime.channels,
                    },
                    side_a_language=runtime.side_a_language,
                    side_b_language=runtime.side_b_language,
                    live_settings=deepcopy(runtime.live_settings),
                    tts_settings=deepcopy(runtime.tts_settings),
                    voice_mode=runtime.voice_mode,
                    voice_cloning_status={
                        lane_id: runtime._voice_cloning_status_payload(lane_id)
                        for lane_id in runtime.lanes
                    },
                    lanes={
                        lane_id: runtime._lane_payload(lane)
                        for lane_id, lane in runtime.lanes.items()
                    },
                    current_turn=runtime._turn_payload(runtime.current_turn),
                )
            )
            while not self.closed:
                kind, incoming = await self.wait_for_input()
                if self.closed:
                    break
                if kind == "session_duration_limit":
                    await self.end_for_duration_limit()
                    break
                if kind == "asr":
                    await runtime._process_asr(force=False)
                    continue
                if incoming is None:
                    continue
                if incoming.get("type") == "websocket.disconnect":
                    break
                raw_bytes = incoming.get("bytes")
                if raw_bytes is not None:
                    await runtime._handle_audio(raw_bytes)
                    continue
                raw_text = incoming.get("text")
                if raw_text is not None:
                    keep_open = await runtime._handle_control(raw_text)
                    if not keep_open:
                        break
        finally:
            await self.close()

    def notify_asr_ready(self) -> None:
        loop = self.loop
        ready = self.asr_ready
        if loop is None or ready is None:
            return
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(ready.set)

    async def wait_for_input(self) -> tuple[str, dict[str, Any] | None]:
        loop = self.loop or asyncio.get_running_loop()
        deadline = self.deadline_mono
        if deadline is not None and loop.time() >= deadline:
            return "session_duration_limit", None

        ready = self.asr_ready
        if ready is not None and ready.is_set():
            ready.clear()
            return "asr", None

        receive_task = asyncio.create_task(self.runtime.websocket.receive())
        tasks: set[asyncio.Task[Any]] = {receive_task}
        ready_task: asyncio.Task[Any] | None = None
        if ready is not None:
            ready_task = asyncio.create_task(ready.wait())
            tasks.add(ready_task)
        timeout = None if deadline is None else max(0.0, deadline - loop.time())
        done, _ = await asyncio.wait(
            tasks,
            timeout=timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )

        if not done:
            await cancel_task(ready_task)
            await cancel_task(receive_task)
            return "session_duration_limit", None

        if receive_task in done:
            await cancel_task(ready_task)
            return "websocket", receive_task.result()

        if ready is not None:
            ready.clear()
        await cancel_task(receive_task)
        return "asr", None

    async def end_for_duration_limit(self) -> None:
        await self._end_for_guardrail(
            reason="session_duration_limit",
            message=(
                "Voice session stopped after reaching its "
                f"{_format_duration(self.max_duration_s)} time limit."
            ),
            max_duration_s=self.max_duration_s,
        )

    async def end_for_storage_limit(self, *, limit_bytes: int) -> None:
        await self._end_for_guardrail(
            reason="session_storage_limit",
            message=(
                "Voice session stopped because its temporary audio reached "
                f"the {_format_bytes(limit_bytes)} storage limit."
            ),
            max_artifact_bytes=int(limit_bytes),
        )

    async def _end_for_guardrail(
        self,
        *,
        reason: str,
        message: str,
        **fields: Any,
    ) -> None:
        if self.closed:
            return
        self.closed = True
        self.listening = False
        self.close_reason = reason
        with contextlib.suppress(KeyError):
            SESSIONS.update(self.runtime.session_id, state="completed")
        with contextlib.suppress(Exception):
            await self.send(
                event(
                    "ended",
                    self.runtime.session_id,
                    reason=reason,
                    message=message,
                    **fields,
                )
            )
        with contextlib.suppress(Exception):
            await self.runtime.websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
        if self.asr_ready is not None:
            self.asr_ready.set()

    async def pause_listening(self) -> None:
        runtime = self.runtime
        self.listening = False
        await self.discard_runtime_work()
        SESSIONS.update(runtime.session_id, state="completed")
        await self.send(event("ended", runtime.session_id, reason="pause_listening"))
        with contextlib.suppress(Exception):
            await runtime.websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
        self.closed = True

    async def discard_runtime_work(self) -> None:
        runtime = self.runtime
        runtime.tts_delivery.clear()
        for lane in runtime.lanes.values():
            inflight = lane.asr_inflight
            if inflight is not None:
                sequence_id = runtime._sequence_from_request(inflight.job.request_id)
                lane.asr_runner.clear_inflight_work(sequence_id=sequence_id)
                runtime.asr_bridge.discard_request(inflight.job.request_id)
                lane.asr_inflight = None
            await cancel_task(lane.translation_task)
            await cancel_task(lane.tts_task)
            lane.translation_task = None
            lane.tts_task = None
            lane.pending_tts.clear()

    async def close(self) -> None:
        runtime = self.runtime
        self.closed = True
        runtime.tts_delivery.clear()
        for lane in runtime.lanes.values():
            await cancel_task(lane.translation_task)
            await cancel_task(lane.tts_task)
            lane.translation_task = None
            lane.tts_task = None
        runtime.asr_bridge.close()
        try:
            SESSIONS.close(runtime.session_id, reason=self.close_reason)
        finally:
            release_session_artifact_tracking(runtime.session_id)

    async def send(self, payload: dict[str, Any]) -> None:
        async with self.send_lock:
            await self.runtime.websocket.send_json(payload)


def _format_duration(seconds: int | float) -> str:
    value = float(seconds)
    if value >= 60 and value % 60 == 0:
        minutes = int(value // 60)
        return f"{minutes}-minute"
    return f"{value:g}-second"


def _format_bytes(byte_count: int) -> str:
    size = max(0, int(byte_count))
    for unit, divisor in (
        ("TiB", 1024**4),
        ("GiB", 1024**3),
        ("MiB", 1024**2),
        ("KiB", 1024),
    ):
        if size >= divisor:
            value = size / divisor
            formatted = f"{value:.1f}".rstrip("0").rstrip(".")
            return f"{formatted} {unit}"
    return f"{size} byte" if size == 1 else f"{size} bytes"
