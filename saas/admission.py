"""In-process rate and concurrency admission for expensive host operations."""
from __future__ import annotations

import math
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Iterator

from saas.errors import RATE_LIMIT_EXCEEDED, SaasError
from saas.principals import Principal

_MINUTE_S = 60.0
_HOUR_S = 3600.0
_CLEANUP_INTERVAL_S = 60.0


@dataclass
class _AdmissionBucket:
    attempts: deque[float] = field(default_factory=deque)
    active: int = 0


class AdmissionController:
    """Atomic per-principal admission for one named operation class.

    Windows are intentionally process-local. The app currently runs one worker;
    a distributed deployment must replace this implementation with a shared
    store before adding workers.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buckets: dict[tuple[str, str, str, str], _AdmissionBucket] = {}
        self._last_cleanup_at = 0.0

    @contextmanager
    def admit(
        self,
        principal: Principal,
        *,
        operation: str,
        max_per_minute: int,
        max_per_hour: int,
        max_concurrent: int,
        now: float | None = None,
    ) -> Iterator[None]:
        limits = (int(max_per_minute), int(max_per_hour), int(max_concurrent))
        if any(limit < 1 for limit in limits):
            raise ValueError("admission limits must be positive")
        timestamp = time.monotonic() if now is None else float(now)
        key = (principal.tenant, principal.kind, str(principal.id), str(operation))
        self._enter(
            key,
            timestamp,
            max_per_minute=limits[0],
            max_per_hour=limits[1],
            max_concurrent=limits[2],
        )
        try:
            yield
        finally:
            self._leave(key)

    def _enter(
        self,
        key: tuple[str, str, str, str],
        now: float,
        *,
        max_per_minute: int,
        max_per_hour: int,
        max_concurrent: int,
    ) -> None:
        with self._lock:
            self._cleanup(now)
            bucket = self._buckets.setdefault(key, _AdmissionBucket())
            self._prune(bucket, now)
            if bucket.active >= max_concurrent:
                raise SaasError(
                    RATE_LIMIT_EXCEEDED,
                    "another operation is already running",
                    status_code=429,
                    details={
                        "constraint": "concurrent",
                        "limit": max_concurrent,
                        "retry_after_s": 5,
                    },
                )

            minute_attempts = [stamp for stamp in bucket.attempts if stamp > now - _MINUTE_S]
            if len(minute_attempts) >= max_per_minute:
                retry_after = max(1, math.ceil(minute_attempts[0] + _MINUTE_S - now))
                raise self._rate_error(max_per_minute, int(_MINUTE_S), retry_after)
            if len(bucket.attempts) >= max_per_hour:
                retry_after = max(1, math.ceil(bucket.attempts[0] + _HOUR_S - now))
                raise self._rate_error(max_per_hour, int(_HOUR_S), retry_after)

            bucket.attempts.append(now)
            bucket.active += 1

    def _leave(self, key: tuple[str, str, str, str]) -> None:
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is not None:
                bucket.active = max(0, bucket.active - 1)

    def _cleanup(self, now: float) -> None:
        if now - self._last_cleanup_at < _CLEANUP_INTERVAL_S:
            return
        for key, bucket in list(self._buckets.items()):
            self._prune(bucket, now)
            if not bucket.attempts and bucket.active == 0:
                self._buckets.pop(key, None)
        self._last_cleanup_at = now

    @staticmethod
    def _prune(bucket: _AdmissionBucket, now: float) -> None:
        cutoff = now - _HOUR_S
        while bucket.attempts and bucket.attempts[0] <= cutoff:
            bucket.attempts.popleft()

    @staticmethod
    def _rate_error(limit: int, window_s: int, retry_after_s: int) -> SaasError:
        return SaasError(
            RATE_LIMIT_EXCEEDED,
            f"too many operations; try again in {retry_after_s} seconds",
            status_code=429,
            details={
                "constraint": "rate",
                "limit": int(limit),
                "window_s": int(window_s),
                "retry_after_s": int(retry_after_s),
            },
        )
