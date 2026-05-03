from __future__ import annotations

import re
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from asr_pool_api import (
    ASRAudioFile,
    ASRCompletionEvent,
    ASRCompletionFeedReset,
    ASROutputSelection,
    ASRPoolClient,
    ASRPoolClientConfig,
    ASRPoolError,
    ASRRequestOptions,
    ASRRequestRouting,
    ASRSubmitRequest,
)

from app.config import REPO_ROOT, get_bool, get_int, get_setting, get_str, optional_str


_SPEAKER_PREFIX_RE = re.compile(
    r"^\s*\[?\s*((?:speaker[_ ]?\d+|spk[_ ]?\d+))\s*\]?\s*[:\-]",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ASRJob:
    request_id: str
    t0_ms: int
    t1_ms: int


@dataclass(frozen=True)
class ASRJobResult:
    request_id: str
    done: bool
    ok: bool
    state: str
    text: str = ""
    segments: list[dict[str, Any]] | None = None
    error: str = ""


class LiveASRPoolBridge:
    def __init__(self, *, session_id: str, sample_rate_hz: int, channels: int) -> None:
        self.session_id = str(session_id)
        self.sample_rate_hz = int(sample_rate_hz)
        self.channels = int(channels)
        self.chunks_root = (REPO_ROOT / "data" / "asr_chunks" / _safe_token(session_id)).resolve()
        self.consumer_id = f"conv_{_safe_token(session_id)[:96]}"
        self._client = ASRPoolClient(
            ASRPoolClientConfig(
                base_url=get_str("asr_pool.base_url", "http://127.0.0.1:8090"),
                token=get_str("asr_pool.token", ""),
            )
        )
        self._request_meta: dict[str, dict[str, Any]] = {}
        self._terminal_events: dict[str, dict[str, Any]] = {}
        self._discarded_request_ids: set[str] = set()
        self._feed_generation = 0
        self._request_generation = 0
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._notify: Callable[[], None] | None = None

    def start_completion_stream(self, *, on_terminal_event: Callable[[], None]) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                self._notify = on_terminal_event
                return
            self._notify = on_terminal_event
            self._stop_event = threading.Event()
            stop_event = self._stop_event

        def _run() -> None:
            try:
                for event in self._client.iter_completions(
                    consumer_id=self.consumer_id,
                    since_seq=0,
                    stop_event=stop_event,
                ):
                    if isinstance(event, ASRCompletionEvent):
                        payload = event.status.to_dict()
                        payload["seq"] = int(event.seq)
                        self._store_completion(payload)
                    elif isinstance(event, ASRCompletionFeedReset):
                        self._store_feed_reset()
            except ASRPoolError:
                return

        thread = threading.Thread(
            target=_run,
            name=f"asr-completions-{_safe_token(self.session_id)[:24]}",
            daemon=True,
        )
        with self._lock:
            self._thread = thread
        thread.start()

    def stop_completion_stream(self) -> None:
        with self._lock:
            stop_event = self._stop_event
            thread = self._thread
            self._thread = None
            self._notify = None
            self._discarded_request_ids.clear()
        stop_event.set()
        if thread is not None:
            thread.join(timeout=1.0)

    def enqueue_pcm16(
        self,
        *,
        chunk_index: int,
        t0_ms: int,
        t1_ms: int,
        pcm16le: bytes,
        language: str | None,
    ) -> ASRJob:
        self.chunks_root.mkdir(parents=True, exist_ok=True)
        idx = int(max(0, chunk_index))
        safe_t0 = int(max(0, t0_ms))
        safe_t1 = int(max(safe_t0, t1_ms))
        with self._lock:
            request_generation = self._request_generation
        request_id = f"conv_{_safe_token(self.session_id)[:48]}_g{request_generation:03d}_{idx:06d}_{safe_t0:09d}_{safe_t1:09d}"[:160]
        wav_path = self.chunks_root / f"{request_id}.wav"
        raw = bytes(pcm16le or b"")
        if len(raw) % 2:
            raw = raw[:-1]
        with wave.open(str(wav_path), "wb") as wf:
            wf.setnchannels(self.channels)
            wf.setsampwidth(2)
            wf.setframerate(self.sample_rate_hz)
            wf.writeframes(raw)

        speaker_mode = "none"
        min_speakers = None
        max_speakers = None
        if get_bool("live.asr.diarize_enabled", False):
            mode = get_str("live.asr.diarize_speaker_mode", "fixed").strip().lower()
            speaker_mode = mode if mode in {"auto", "fixed"} else "fixed"
            if speaker_mode == "fixed":
                min_speakers = get_int("live.asr.diarize_min_speakers", 1, min_value=1)
                max_speakers = get_int("live.asr.diarize_max_speakers", 4, min_value=1)

        submit = ASRSubmitRequest(
            request_id=request_id,
            consumer_id=self.consumer_id,
            priority="interactive",
            routing=ASRRequestRouting(fairness_key=self.session_id),
            audio=ASRAudioFile(
                path=wav_path,
                format="wav",
                duration_ms=max(1, safe_t1 - safe_t0),
                sample_rate_hz=self.sample_rate_hz,
                channels=self.channels,
            ),
            options=ASRRequestOptions(
                language=_normalize_language(language),
                align_enabled=get_bool("live.asr.align_enabled", False),
                diarize_enabled=speaker_mode != "none",
                speaker_mode=speaker_mode,
                min_speakers=min_speakers,
                max_speakers=max_speakers,
                beam_size=_optional_int_setting("live.asr.beam_size"),
                chunk_size=_optional_int_setting("live.asr.chunk_size"),
                asr_backend=optional_str("live.asr.backend"),
            ),
            outputs=ASROutputSelection(text=False, segments=False, srt=True, srt_inline=True),
        )
        status = self._client.submit_audio(submit)
        accepted_id = str(status.request_id or request_id).strip() or request_id
        with self._lock:
            self._request_meta[accepted_id] = {
                "feed_generation": self._feed_generation,
                "t0_ms": safe_t0,
                "t1_ms": safe_t1,
            }
        return ASRJob(request_id=accepted_id, t0_ms=safe_t0, t1_ms=safe_t1)

    def has_terminal_result(self, request_id: str) -> bool:
        rid = str(request_id or "").strip()
        if not rid:
            return False
        with self._lock:
            if rid in self._terminal_events:
                return True
            meta = self._request_meta.get(rid)
            if not meta:
                return False
            return int(meta.get("feed_generation") or 0) < self._feed_generation

    def discard_request(self, request_id: str) -> None:
        rid = str(request_id or "").strip()
        if not rid:
            return
        with self._lock:
            self._request_meta.pop(rid, None)
            self._terminal_events.pop(rid, None)
            self._discarded_request_ids.add(rid)

    def advance_generation(self) -> None:
        with self._lock:
            self._request_generation += 1
            self._discarded_request_ids.update(self._request_meta.keys())
            self._request_meta.clear()
            self._terminal_events.clear()

    def take_terminal_result(self, request_id: str, *, t0_offset_ms: int) -> ASRJobResult:
        rid = str(request_id or "").strip()
        with self._lock:
            meta = dict(self._request_meta.get(rid) or {})
            terminal = dict(self._terminal_events.pop(rid, {}) or {})
            feed_generation = self._feed_generation
        if not meta:
            return ASRJobResult(request_id=rid, done=True, ok=False, state="error", error="missing_asr_request_meta")
        if not terminal:
            if int(meta.get("feed_generation") or 0) < feed_generation:
                return ASRJobResult(request_id=rid, done=True, ok=False, state="error", error="asr_completion_feed_reset")
            return ASRJobResult(request_id=rid, done=False, ok=False, state="queued")

        raw_state = str(terminal.get("state") or "").strip().lower()
        if raw_state == "completed":
            response = dict(terminal.get("response") or {})
            result = dict(response.get("result") or {})
            srt_text = str(result.get("srt_text") or "")
            segments = _parse_srt_segments(srt_text, t0_offset_ms=t0_offset_ms)
            text = "\n".join(str(seg.get("text") or "").strip() for seg in segments if str(seg.get("text") or "").strip())
            with self._lock:
                self._request_meta.pop(rid, None)
            return ASRJobResult(
                request_id=rid,
                done=True,
                ok=True,
                state="done",
                text=text,
                segments=segments,
            )

        err = dict(terminal.get("error") or {})
        message = str(err.get("message") or f"asr_terminal_state:{raw_state or 'unknown'}")
        with self._lock:
            self._request_meta.pop(rid, None)
        return ASRJobResult(request_id=rid, done=True, ok=False, state="error", error=message)

    def _store_completion(self, payload: dict[str, Any]) -> None:
        rid = str(payload.get("request_id") or "").strip()
        state = str(payload.get("state") or "").strip().lower()
        if not rid or state not in {"completed", "failed", "cancelled"}:
            return
        notify = None
        with self._lock:
            if rid in self._discarded_request_ids:
                self._discarded_request_ids.discard(rid)
                return
            self._terminal_events[rid] = dict(payload)
            notify = self._notify
        if notify is not None:
            notify()

    def _store_feed_reset(self) -> None:
        notify = None
        with self._lock:
            self._feed_generation += 1
            self._discarded_request_ids.clear()
            notify = self._notify
        if notify is not None:
            notify()


def _optional_int_setting(path: str) -> int | None:
    raw = get_setting(path, None)
    if raw is None:
        return None
    return int(max(1, int(raw)))


def _normalize_language(language: str | None) -> str | None:
    text = str(language or "").strip().lower()
    return text or None


def _safe_token(value: str) -> str:
    text = str(value or "").strip() or "unknown"
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in text)


def _srt_ts_to_ms(token: str) -> int:
    parts = str(token or "").strip().split(":")
    if len(parts) != 3:
        return 0
    sec_ms = parts[2].split(",")
    return (
        int(parts[0] or 0) * 3600 * 1000
        + int(parts[1] or 0) * 60 * 1000
        + int(sec_ms[0] or 0) * 1000
        + (int(sec_ms[1] or 0) if len(sec_ms) > 1 else 0)
    )


def _parse_srt_segments(srt_text: str, *, t0_offset_ms: int) -> list[dict[str, Any]]:
    text = str(srt_text or "").replace("\r\n", "\n").replace("\r", "\n")
    blocks = [block.strip() for block in text.split("\n\n") if block.strip()]
    out: list[dict[str, Any]] = []
    for block in blocks:
        lines = [line for line in block.split("\n") if line.strip()]
        if len(lines) < 2:
            continue
        time_idx = 1 if "-->" in lines[1] else 0
        if "-->" not in lines[time_idx]:
            continue
        start_raw, end_raw = [part.strip() for part in lines[time_idx].split("-->", 1)]
        seg_text = "\n".join(line.strip() for line in lines[time_idx + 1 :] if line.strip()).strip()
        if not seg_text:
            continue
        speaker = ""
        match = _SPEAKER_PREFIX_RE.match(seg_text)
        if match:
            speaker = str(match.group(1) or "").strip().upper().replace(" ", "_")
        t0_ms = _srt_ts_to_ms(start_raw) + int(max(0, t0_offset_ms))
        t1_ms = _srt_ts_to_ms(end_raw) + int(max(0, t0_offset_ms))
        out.append(
            {
                "segment_id": f"s{len(out) + 1:04d}",
                "text": seg_text,
                "t0_ms": int(max(0, t0_ms)),
                "t1_ms": int(max(t0_ms, t1_ms)),
                "speaker": speaker,
            }
        )
    return out
