"""Admission and short retry caching for live typed translation."""
from __future__ import annotations

import hashlib
import json
import threading
import time
from collections import OrderedDict
from contextlib import AbstractContextManager
from typing import Any

from saas.admission import AdmissionController
from saas.entitlements import EntitlementSet
from saas.principals import Principal


CacheKey = tuple[str, str, str, str]


class TextTranslationSuccessCache:
    """Bounded process-local cache for identical successful retries."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: OrderedDict[CacheKey, tuple[float, dict[str, Any]]] = OrderedDict()

    def get(
        self,
        principal: Principal,
        payload_hash: str,
        *,
        now: float | None = None,
    ) -> dict[str, Any] | None:
        timestamp = time.monotonic() if now is None else float(now)
        key = self._key(principal, payload_hash)
        with self._lock:
            self._prune(timestamp)
            entry = self._entries.get(key)
            if entry is None:
                return None
            self._entries.move_to_end(key)
            return dict(entry[1])

    def put(
        self,
        principal: Principal,
        payload_hash: str,
        result: dict[str, Any],
        *,
        ttl_s: int,
        max_entries: int,
        now: float | None = None,
    ) -> None:
        if ttl_s < 1 or max_entries < 1:
            raise ValueError("text translation cache limits must be positive")
        timestamp = time.monotonic() if now is None else float(now)
        key = self._key(principal, payload_hash)
        with self._lock:
            self._prune(timestamp)
            self._entries[key] = (timestamp + ttl_s, dict(result))
            self._entries.move_to_end(key)
            while len(self._entries) > max_entries:
                self._entries.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def _prune(self, now: float) -> None:
        expired = [key for key, (expires_at, _) in self._entries.items() if expires_at <= now]
        for key in expired:
            self._entries.pop(key, None)

    @staticmethod
    def _key(principal: Principal, payload_hash: str) -> CacheKey:
        return principal.tenant, principal.kind, str(principal.id), str(payload_hash)


def text_translation_payload_hash(
    *,
    source_language: str,
    target_language: str,
    text: str,
    final: bool,
) -> str:
    encoded = json.dumps(
        {
            "final": bool(final),
            "source_language": str(source_language),
            "target_language": str(target_language),
            "text": str(text),
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


_admission = AdmissionController()
success_cache = TextTranslationSuccessCache()


def admit_text_translation(
    principal: Principal,
    entitlements: EntitlementSet,
) -> AbstractContextManager[None]:
    return _admission.admit(
        principal,
        operation="text_translation",
        max_per_minute=entitlements.get_int("text_translation.max_jobs_per_minute"),
        max_per_hour=entitlements.get_int("text_translation.max_jobs_per_hour"),
        max_concurrent=entitlements.get_int("text_translation.max_concurrent_jobs"),
    )
