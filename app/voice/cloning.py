"""Bounded, session-local speaker-reference construction."""

from __future__ import annotations

import hashlib
import io
import json
import time
import wave
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import REPO_ROOT, get_float
from app.voice.session_storage import write_session_artifact


REFERENCE_ROOT = (REPO_ROOT / "data" / "tts").resolve()
MAX_SOURCE_RESULTS_PER_LANE = 24


@dataclass(frozen=True)
class VoiceCloningReference:
    reference_id: str
    wav_path: str
    prompt_text: str
    duration_ms: int
    segment_count: int
    source_request_ids: tuple[str, ...]
    created_mono: float


@dataclass(frozen=True)
class _SegmentCandidate:
    request_id: str
    wav_path: str
    wav_t0_ms: int
    wav_t1_ms: int
    segment_id: str
    t0_ms: int
    t1_ms: int
    text: str

    @property
    def duration_ms(self) -> int:
        return self.t1_ms - self.t0_ms


class VoiceCloningWindow:
    """Select and materialize one recent Prompt + reference pair per lane."""

    def __init__(self, *, session_id: str, lane_ids: tuple[str, ...]) -> None:
        self.session_id = str(session_id)
        self.min_duration_ms, self.max_duration_ms = _duration_bounds_ms()
        self.enabled = False
        self._candidates = {
            lane_id: deque(maxlen=MAX_SOURCE_RESULTS_PER_LANE)
            for lane_id in lane_ids
        }
        self._references: dict[str, VoiceCloningReference] = {}

    def set_enabled(self, enabled: bool) -> None:
        next_enabled = bool(enabled)
        if next_enabled == self.enabled:
            return
        self.enabled = next_enabled
        if not next_enabled:
            for candidates in self._candidates.values():
                candidates.clear()
            self._references.clear()

    def state(self, lane_id: str) -> str:
        if not self.enabled:
            return "off"
        return "ready" if self.reference(lane_id) is not None else "preparing"

    def reason(self, lane_id: str) -> str:
        state = self.state(lane_id)
        if state == "off":
            return "disabled"
        if state == "ready":
            return "reference_ready"
        return "insufficient_clear_speech"

    def reference(self, lane_id: str) -> VoiceCloningReference | None:
        return self._references.get(str(lane_id))

    def status_payload(self, lane_id: str) -> dict[str, Any]:
        reference = self.reference(lane_id)
        payload: dict[str, Any] = {
            "lane_id": str(lane_id),
            "state": self.state(lane_id),
            "reason": self.reason(lane_id),
        }
        if reference is not None:
            payload.update(
                reference_id=reference.reference_id,
                duration_ms=reference.duration_ms,
                segment_count=reference.segment_count,
            )
        return payload

    def record_asr_result(
        self,
        *,
        lane_id: str,
        request_id: str,
        wav_path: str,
        wav_t0_ms: int,
        wav_t1_ms: int,
        segments: list[dict[str, Any]],
    ) -> bool:
        """Record one terminal ASR result; return whether reference identity changed."""
        if not self.enabled or lane_id not in self._candidates:
            return False
        candidates = _normalize_candidates(
            request_id=request_id,
            wav_path=wav_path,
            wav_t0_ms=wav_t0_ms,
            wav_t1_ms=wav_t1_ms,
            segments=segments,
        )
        if candidates:
            self._candidates[lane_id].append(candidates)
        selected = _select_candidates(
            self._candidates[lane_id],
            min_duration_ms=self.min_duration_ms,
            max_duration_ms=self.max_duration_ms,
        )
        if not selected:
            return False
        reference_id = _reference_id(lane_id, selected)
        current = self._references.get(lane_id)
        if current is not None and current.reference_id == reference_id:
            return False
        reference = _materialize_reference(
            session_id=self.session_id,
            lane_id=lane_id,
            reference_id=reference_id,
            selected=selected,
            min_duration_ms=self.min_duration_ms,
            max_duration_ms=self.max_duration_ms,
        )
        self._references[lane_id] = reference
        return current is None or current.reference_id != reference.reference_id


def _duration_bounds_ms() -> tuple[int, int]:
    min_s = get_float(
        "tts.voice_cloning.recent_speech_window.min_duration_s",
        3.0,
        min_value=0.1,
    )
    max_s = get_float(
        "tts.voice_cloning.recent_speech_window.max_duration_s",
        10.0,
        min_value=0.1,
    )
    if min_s > max_s:
        raise ValueError("voice cloning min_duration_s must not exceed max_duration_s")
    return round(min_s * 1000), round(max_s * 1000)


def _normalize_candidates(
    *,
    request_id: str,
    wav_path: str,
    wav_t0_ms: int,
    wav_t1_ms: int,
    segments: list[dict[str, Any]],
) -> tuple[_SegmentCandidate, ...]:
    safe_path = str(wav_path or "").strip()
    safe_request_id = str(request_id or "").strip()
    start = max(0, int(wav_t0_ms))
    end = max(start, int(wav_t1_ms))
    if not safe_path or not safe_request_id or end <= start or not Path(safe_path).is_file():
        return ()
    result: list[_SegmentCandidate] = []
    for index, raw in enumerate(segments or []):
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("text") or "").strip()
        t0_ms = int(max(0, raw.get("t0_ms") or 0))
        t1_ms = int(max(t0_ms, raw.get("t1_ms") or 0))
        if not text or t1_ms <= t0_ms or t0_ms < start or t1_ms > end:
            continue
        result.append(
            _SegmentCandidate(
                request_id=safe_request_id,
                wav_path=safe_path,
                wav_t0_ms=start,
                wav_t1_ms=end,
                segment_id=str(raw.get("segment_id") or raw.get("id") or index),
                t0_ms=t0_ms,
                t1_ms=t1_ms,
                text=text,
            )
        )
    return tuple(result)


def _select_candidates(
    results: deque[tuple[_SegmentCandidate, ...]],
    *,
    min_duration_ms: int,
    max_duration_ms: int,
) -> tuple[_SegmentCandidate, ...]:
    selected: list[_SegmentCandidate] = []
    selected_intervals: list[tuple[int, int]] = []
    duration_ms = 0
    for result in reversed(results):
        for candidate in reversed(result):
            if candidate.duration_ms > max_duration_ms:
                continue
            interval = (candidate.t0_ms, candidate.t1_ms)
            if any(_overlaps(interval, existing) for existing in selected_intervals):
                continue
            if duration_ms + candidate.duration_ms > max_duration_ms:
                continue
            selected.append(candidate)
            selected_intervals.append(interval)
            duration_ms += candidate.duration_ms
            if duration_ms >= min_duration_ms:
                return tuple(sorted(selected, key=lambda item: (item.t0_ms, item.t1_ms)))
    return ()


def _overlaps(left: tuple[int, int], right: tuple[int, int]) -> bool:
    return left[0] < right[1] and right[0] < left[1]


def _reference_id(lane_id: str, selected: tuple[_SegmentCandidate, ...]) -> str:
    identity = [
        [
            candidate.t0_ms,
            candidate.t1_ms,
            candidate.text,
        ]
        for candidate in selected
    ]
    digest = hashlib.sha256(
        json.dumps(identity, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:20]
    return f"clone_{lane_id}_{digest}"


def _materialize_reference(
    *,
    session_id: str,
    lane_id: str,
    reference_id: str,
    selected: tuple[_SegmentCandidate, ...],
    min_duration_ms: int,
    max_duration_ms: int,
) -> VoiceCloningReference:
    output = io.BytesIO()
    output_params: tuple[int, int, int] | None = None
    total_frames = 0
    with wave.open(output, "wb") as writer:
        for candidate in selected:
            with wave.open(candidate.wav_path, "rb") as reader:
                params = (reader.getnchannels(), reader.getsampwidth(), reader.getframerate())
                if output_params is None:
                    output_params = params
                    writer.setnchannels(params[0])
                    writer.setsampwidth(params[1])
                    writer.setframerate(params[2])
                elif params != output_params:
                    raise ValueError("voice cloning source WAV formats do not match")
                relative_start_ms = candidate.t0_ms - candidate.wav_t0_ms
                relative_end_ms = candidate.t1_ms - candidate.wav_t0_ms
                start_frame = round(relative_start_ms * params[2] / 1000)
                end_frame = round(relative_end_ms * params[2] / 1000)
                if start_frame < 0 or end_frame <= start_frame or end_frame > reader.getnframes():
                    raise ValueError("voice cloning segment falls outside source WAV")
                reader.setpos(start_frame)
                frames = reader.readframes(end_frame - start_frame)
                if len(frames) != (end_frame - start_frame) * params[0] * params[1]:
                    raise ValueError("voice cloning source WAV ended unexpectedly")
                writer.writeframesraw(frames)
                total_frames += end_frame - start_frame
    if output_params is None or total_frames <= 0:
        raise ValueError("voice cloning reference is empty")
    duration_ms = round(total_frames * 1000 / output_params[2])
    if duration_ms < min_duration_ms or duration_ms > max_duration_ms:
        raise ValueError("voice cloning reference duration is outside configured bounds")
    prompt_text = " ".join(candidate.text for candidate in selected).strip()
    if not prompt_text:
        raise ValueError("voice cloning reference transcript is empty")
    destination = (
        REFERENCE_ROOT / session_id / "voice_cloning" / lane_id / f"{reference_id}.wav"
    ).resolve()
    write_session_artifact(session_id, destination, output.getvalue())
    return VoiceCloningReference(
        reference_id=reference_id,
        wav_path=str(destination),
        prompt_text=prompt_text,
        duration_ms=duration_ms,
        segment_count=len(selected),
        source_request_ids=tuple(dict.fromkeys(item.request_id for item in selected)),
        created_mono=time.monotonic(),
    )
