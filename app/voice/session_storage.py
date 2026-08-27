"""Bound temporary ASR and TTS artifacts for one voice session."""

from __future__ import annotations

import re
import stat
import threading
from dataclasses import dataclass, field
from pathlib import Path

from app.config import REPO_ROOT, get_int


SESSION_ARTIFACT_ROOTS = (
    (REPO_ROOT / "data" / "asr_chunks").resolve(),
    (REPO_ROOT / "data" / "tts").resolve(),
)
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


@dataclass
class _SessionUsage:
    lock: threading.Lock = field(default_factory=threading.Lock)
    used_bytes: int | None = None


_USAGE_LOCK = threading.Lock()
_SESSION_USAGE: dict[tuple[str, tuple[Path, ...]], _SessionUsage] = {}


class SessionArtifactLimitExceeded(RuntimeError):
    def __init__(
        self,
        *,
        limit_bytes: int,
        used_bytes: int,
        requested_bytes: int,
    ) -> None:
        self.limit_bytes = int(limit_bytes)
        self.used_bytes = int(used_bytes)
        self.requested_bytes = int(requested_bytes)
        super().__init__("voice session artifact storage limit exceeded")


def session_artifact_limit_bytes() -> int:
    return get_int(
        "live.max_session_artifact_bytes",
        256 * 1024 * 1024,
        min_value=1,
    )


def session_artifact_bytes(
    session_id: str,
    *,
    extra_directory: Path | None = None,
) -> int:
    _, directories = _session_artifact_directories(
        session_id,
        extra_directory=extra_directory,
    )
    return sum(_directory_bytes(directory) for directory in directories)


def write_session_artifact(session_id: str, path: Path, data: bytes) -> None:
    destination = path.resolve()
    payload = bytes(data)
    token, directories = _session_artifact_directories(
        session_id,
        extra_directory=destination.parent,
    )
    usage = _session_usage(token, directories)
    with usage.lock:
        if usage.used_bytes is None:
            usage.used_bytes = sum(
                _directory_bytes(directory) for directory in directories
            )
        used_bytes = usage.used_bytes
        previous_bytes = _file_size(destination)
        retained_bytes = max(0, used_bytes - previous_bytes)
        limit_bytes = session_artifact_limit_bytes()
        next_used_bytes = retained_bytes + len(payload)
        if next_used_bytes > limit_bytes:
            raise SessionArtifactLimitExceeded(
                limit_bytes=limit_bytes,
                used_bytes=used_bytes,
                requested_bytes=len(payload),
            )
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            destination.write_bytes(payload)
        except Exception:
            usage.used_bytes = None
            raise
        usage.used_bytes = next_used_bytes


def release_session_artifact_tracking(session_id: str) -> None:
    token = _session_token(session_id)
    with _USAGE_LOCK:
        for key in [key for key in _SESSION_USAGE if key[0] == token]:
            _SESSION_USAGE.pop(key, None)


def _session_usage(
    token: str,
    directories: tuple[Path, ...],
) -> _SessionUsage:
    key = token, directories
    with _USAGE_LOCK:
        usage = _SESSION_USAGE.get(key)
        if usage is None:
            usage = _SessionUsage()
            _SESSION_USAGE[key] = usage
        return usage


def _session_artifact_directories(
    session_id: str,
    *,
    extra_directory: Path | None = None,
) -> tuple[str, tuple[Path, ...]]:
    token = _session_token(session_id)
    directories: list[Path] = []
    for root in SESSION_ARTIFACT_ROOTS:
        resolved_root = root.resolve()
        directory = (resolved_root / token).resolve()
        directory.relative_to(resolved_root)
        directories.append(directory)
    if extra_directory is not None:
        resolved_extra = extra_directory.resolve()
        if not any(
            resolved_extra == directory or resolved_extra.is_relative_to(directory)
            for directory in directories
        ):
            directories.append(resolved_extra)
    return token, tuple(directories)


def _session_token(session_id: str) -> str:
    token = str(session_id or "").strip()
    if not token:
        raise ValueError("session_id_required")
    if _SESSION_ID_RE.fullmatch(token) is None:
        raise ValueError("invalid_session_id")
    return token


def _file_size(path: Path) -> int:
    try:
        file_stat = path.stat()
    except FileNotFoundError:
        return 0
    return file_stat.st_size if stat.S_ISREG(file_stat.st_mode) else 0


def _directory_bytes(directory: Path) -> int:
    if not directory.is_dir():
        return 0
    total = 0
    for path in directory.rglob("*"):
        try:
            file_stat = path.stat()
        except FileNotFoundError:
            continue
        if stat.S_ISREG(file_stat.st_mode):
            total += file_stat.st_size
    return total
