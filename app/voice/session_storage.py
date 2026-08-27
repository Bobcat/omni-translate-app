"""Bound temporary ASR and TTS artifacts for one voice session."""

from __future__ import annotations

import threading
from pathlib import Path

from app.config import REPO_ROOT, get_int


SESSION_ARTIFACT_ROOTS = (
    (REPO_ROOT / "data" / "asr_chunks").resolve(),
    (REPO_ROOT / "data" / "tts").resolve(),
)
_WRITE_LOCK = threading.Lock()


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
    directories = list(_session_artifact_directories(session_id))
    if extra_directory is not None:
        resolved_extra = extra_directory.resolve()
        if not any(
            resolved_extra == directory or resolved_extra.is_relative_to(directory)
            for directory in directories
        ):
            directories.append(resolved_extra)
    return sum(_directory_bytes(directory) for directory in directories)


def write_session_artifact(session_id: str, path: Path, data: bytes) -> None:
    destination = path.resolve()
    payload = bytes(data)
    with _WRITE_LOCK:
        used_bytes = session_artifact_bytes(
            session_id,
            extra_directory=destination.parent,
        )
        previous_bytes = destination.stat().st_size if destination.is_file() else 0
        retained_bytes = max(0, used_bytes - previous_bytes)
        limit_bytes = session_artifact_limit_bytes()
        if retained_bytes + len(payload) > limit_bytes:
            raise SessionArtifactLimitExceeded(
                limit_bytes=limit_bytes,
                used_bytes=used_bytes,
                requested_bytes=len(payload),
            )
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(payload)


def _session_artifact_directories(session_id: str) -> tuple[Path, ...]:
    token = str(session_id or "").strip()
    if not token:
        raise ValueError("session_id_required")
    directories: list[Path] = []
    for root in SESSION_ARTIFACT_ROOTS:
        directory = (root / token).resolve()
        try:
            directory.relative_to(root)
        except ValueError as exc:
            raise ValueError("invalid_session_id") from exc
        directories.append(directory)
    return tuple(directories)


def _directory_bytes(directory: Path) -> int:
    if not directory.is_dir():
        return 0
    total = 0
    for path in directory.rglob("*"):
        if path.is_file():
            total += path.stat().st_size
    return total
