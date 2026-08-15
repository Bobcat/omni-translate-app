"""TTS synthesis, replay, playback settlement, and reference snapshots."""

from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from app.protocol import event
from app.tts_bridge import TTS_ROOT
from app.tts_bridge import TtsReferenceUnavailableError
from app.tts_bridge import _safe_token as _tts_safe_token
from app.tts_bridge import get_tts_bridge
from app.tts_bridge import tts_settings_enabled
from app.tts_bridge import tts_uses_asr_reference_wav

if TYPE_CHECKING:
    from app.runtime import ConversationLane
    from app.runtime import ConversationRuntime
    from app.runtime import TurnPart


LOGGER = logging.getLogger("asr_translate_tts.voice.tts_delivery")
LAST_SPEECH_QUALITY_THRESHOLD = 0.7


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

    async def replay(self, payload: dict[str, Any]) -> None:
        runtime = self.runtime
        lane_id = str(payload.get("lane_id") or "").strip()
        text = str(payload.get("text") or "").strip()
        if not text:
            return
        lane = runtime.lanes.get(lane_id) if lane_id else runtime._current_lane()
        if lane is None or not tts_settings_enabled(runtime.tts_settings):
            return
        reference_wav_path = self._replay_reference_wav_path(lane, text)
        try:
            tts_payload = await asyncio.to_thread(
                self.bridge.synthesize,
                session_id=runtime.session_id,
                text=text,
                language=lane.target_language,
                fairness_key=runtime.tts_fairness_key,
                settings=runtime.tts_settings,
                reference_wav_path=reference_wav_path,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await runtime.lifecycle.send(
                event(
                    "error",
                    runtime.session_id,
                    code="tts_replay_failed",
                    message=str(exc),
                    lane_id=lane.lane_id,
                )
            )
            return
        await runtime.lifecycle.send(
            event(
                "tts_replay_ready",
                runtime.session_id,
                lane_id=lane.lane_id,
                text=text,
                tts=tts_payload,
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
                    if not sub_task.done():
                        sub_task.cancel()
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
            self.snapshot_part_reference_wav(
                speaking_part_ids,
                reference_wav_path,
                low_quality=low_quality,
            )
        reference_prompt_text = _last_speech_prompt_text(lane, reference_wav_path)
        source_audio_duration_ms = _source_bubble_duration_ms(lane)
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
            )
        except asyncio.CancelledError:
            raise
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
            if self._turn_is_speaking(turn_id):
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
        if artifact_id:
            lane.pending_tts[artifact_id] = {
                "turn_id": turn_id,
                "artifact_id": artifact_id,
                "text": text,
                "part_ids": list(speaking_part_ids),
                "tts": dict(tts_payload),
            }
        await runtime.lifecycle.send(
            event(
                "tts_clip_ready",
                runtime.session_id,
                lane_id=lane.lane_id,
                turn_id=turn_id,
                tts=tts_payload,
            )
        )

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

    def record_asr_reference(self, lane: ConversationLane) -> None:
        """Keep the latest ASR WAV that is suitable as a voice reference."""
        wav_path = str(lane.last_asr_wav_path or "").strip()
        if not wav_path:
            return
        if _last_speech_quality_score(lane.last_asr_segments, wav_path) >= LAST_SPEECH_QUALITY_THRESHOLD:
            lane.last_qualifying_asr_wav_path = wav_path

    def snapshot_part_reference_wav(
        self,
        speaking_part_ids: list[str],
        source_path: str | None,
        *,
        low_quality: bool = False,
    ) -> None:
        if not source_path:
            return
        src = Path(source_path)
        if not src.is_file():
            return
        selection = set(speaking_part_ids)
        for part in self.runtime.current_turn.parts:
            if part.part_id not in selection:
                continue
            dst = self._part_reference_wav_target(part.part_id)
            if dst is None:
                continue
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dst)
            except OSError as exc:
                LOGGER.warning("ref-WAV snapshot failed part=%s: %s", part.part_id, exc)
                continue
            part.reference_wav_path = str(dst)
            part.low_quality_reference = low_quality

    def discard_part_reference_wav(self, part: TurnPart) -> None:
        path = part.reference_wav_path
        if not path:
            return
        part.reference_wav_path = ""
        try:
            Path(path).unlink()
        except OSError:
            pass

    def _replay_reference_wav_path(self, lane: ConversationLane, text: str) -> str | None:
        runtime = self.runtime
        if runtime.current_turn.lane_id == lane.lane_id:
            for part in runtime.current_turn.parts:
                if self.part_target_text(part) != text:
                    continue
                stored = part.reference_wav_path or ""
                if stored and Path(stored).is_file():
                    return stored
                break
        return _tts_reference_wav_path(lane, runtime.tts_settings)

    def _part_reference_wav_target(self, part_id: str) -> Path | None:
        try:
            session_token = _tts_safe_token(self.runtime.session_id)
            part_token = _tts_safe_token(part_id)
        except ValueError:
            return None
        return (TTS_ROOT / session_token / "refs" / f"{part_token}.wav").resolve()

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


def _tts_reference_wav_path(
    lane: ConversationLane,
    tts_settings: dict[str, Any],
) -> str | None:
    if not tts_uses_asr_reference_wav(lane.target_language, settings=tts_settings):
        return None
    path = str(lane.last_asr_wav_path or "").strip()
    if not path:
        return None
    return path if Path(path).exists() else None


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
