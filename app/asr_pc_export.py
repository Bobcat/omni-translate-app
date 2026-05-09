from __future__ import annotations

import csv
import io
import json
import re
from pathlib import Path
from typing import Any

from app.config import REPO_ROOT


PC_EXPORT_COLUMNS = (
    "kind",
    "speech_start_ms",
    "speech_end_ms",
    "text",
    "backend",
    "request_id",
    "reason",
    "lane_id",
    "turn_id",
    "line_number",
    "segment_count",
    "avg_logprob_mean",
    "avg_logprob_min",
    "compression_ratio_max",
    "no_speech_prob_max",
    "temperature_max",
    "asr_debug_json",
)


def live_pc_events_to_text(events: list[dict[str, Any]]) -> str:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=list(PC_EXPORT_COLUMNS), lineterminator="\n")
    writer.writeheader()
    for event in events:
        writer.writerow(_event_row(event))
    return out.getvalue()


def pc_export_filename(session_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(session_id or "").strip()).strip("._")
    return f"{safe or 'session'}.pc"


def pc_export_path(session_id: str) -> Path:
    return (REPO_ROOT / "data" / "asr_pc_exports" / pc_export_filename(session_id)).resolve()


def _event_row(event: dict[str, Any]) -> dict[str, Any]:
    debug = event.get("asr_debug") if isinstance(event.get("asr_debug"), dict) else {}
    segments = debug.get("segments") if isinstance(debug.get("segments"), list) else []
    return {
        "kind": str(event.get("kind") or ""),
        "speech_start_ms": _int_cell(event.get("speech_start_ms")),
        "speech_end_ms": _int_cell(event.get("speech_end_ms")),
        "text": _single_line(event.get("text")),
        "backend": str(debug.get("backend") or event.get("backend") or ""),
        "request_id": str(debug.get("request_id") or event.get("request_id") or ""),
        "reason": str(event.get("reason") or ""),
        "lane_id": str(event.get("lane_id") or ""),
        "turn_id": str(event.get("turn_id") or ""),
        "line_number": _int_cell(event.get("line_number")),
        "segment_count": _int_cell(len(segments)),
        "avg_logprob_mean": _float_cell(_mean(_segment_values(segments, "avg_logprob"))),
        "avg_logprob_min": _float_cell(_min(_segment_values(segments, "avg_logprob"))),
        "compression_ratio_max": _float_cell(_max(_segment_values(segments, "compression_ratio"))),
        "no_speech_prob_max": _float_cell(_max(_segment_values(segments, "no_speech_prob"))),
        "temperature_max": _float_cell(_max(_segment_values(segments, "temperature"))),
        "asr_debug_json": _debug_json(debug),
    }


def _single_line(value: Any) -> str:
    return " ".join(str(value or "").replace("\r", "\n").split())


def _int_cell(value: Any) -> str:
    if value is None or value == "":
        return ""
    try:
        return str(int(value))
    except Exception:
        return ""


def _float_cell(value: float | None) -> str:
    if value is None:
        return ""
    return f"{float(value):.6g}"


def _segment_values(segments: list[Any], key: str) -> list[float]:
    out: list[float] = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        value = segment.get(key)
        if value is None and isinstance(segment.get("asr_debug"), dict):
            value = segment["asr_debug"].get(key)
        try:
            out.append(float(value))
        except Exception:
            continue
    return out


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _min(values: list[float]) -> float | None:
    return min(values) if values else None


def _max(values: list[float]) -> float | None:
    return max(values) if values else None


def _debug_json(debug: dict[str, Any]) -> str:
    if not debug:
        return ""
    return json.dumps(debug, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
