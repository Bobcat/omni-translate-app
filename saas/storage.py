"""Persistence for the control layer: anonymous identities and the usage
ledger (SQLite, stdlib only).

The store is deliberately dumb CRUD plus one serialized transaction
primitive; reservation policy lives in ``saas.usage``. A process-wide lock
serializes writes — right-sized for the single-process app. The Postgres
implementation (Supabase phase) keeps this exact method surface and swaps
the lock for row-level locking.

The connection is opened lazily so importing the app never creates the
database file (tests import the app with the default path configured).
"""
from __future__ import annotations

import contextlib
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS anonymous_identities (
    tenant TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS usage_events (
    tenant TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    job_id TEXT,
    metric TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    state TEXT NOT NULL CHECK (state IN ('reserved', 'consumed', 'released', 'adjusted')),
    billable INTEGER NOT NULL DEFAULT 1,
    period_kind TEXT,
    period_start TEXT,
    period_end TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_owner_metric_period
    ON usage_events (tenant, owner_kind, owner_id, metric, period_start, state);
-- The guard row is the per-owner/metric/period serialization point for
-- atomic reservations. It is a lock, not the source of truth: the append-only
-- usage_events ledger is, and the guard can be rebuilt from it.
CREATE TABLE IF NOT EXISTS usage_guard (
    tenant TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    period_start TEXT NOT NULL,
    reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    PRIMARY KEY (tenant, owner_kind, owner_id, metric, period_start)
);
"""


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class SaasStore:
    def __init__(self, path: str | Path) -> None:
        self._path = str(path)
        self._lock = threading.RLock()
        self._conn: sqlite3.Connection | None = None

    def _connection(self) -> sqlite3.Connection:
        with self._lock:
            if self._conn is None:
                Path(self._path).parent.mkdir(parents=True, exist_ok=True)
                self._conn = sqlite3.connect(self._path, check_same_thread=False)
                self._conn.row_factory = sqlite3.Row
                self._conn.executescript(SCHEMA)
            return self._conn

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    @contextlib.contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """One atomic, process-serialized read-modify-write. Re-entrant on
        the same thread: nested calls participate in the open transaction
        instead of beginning a new one, so store helpers compose."""
        with self._lock:
            conn = self._connection()
            if conn.in_transaction:
                yield conn
                return
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
                conn.commit()
            except BaseException:
                conn.rollback()
                raise

    # -- anonymous identities -------------------------------------------------

    def create_identity(self, tenant: str) -> uuid.UUID:
        identity_id = uuid.uuid4()
        now = _utcnow()
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO anonymous_identities (tenant, id, created_at, last_seen_at, status)"
                " VALUES (?, ?, ?, ?, 'active')",
                (tenant, str(identity_id), now, now),
            )
        return identity_id

    def get_identity(self, tenant: str, identity_id: uuid.UUID) -> sqlite3.Row | None:
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM anonymous_identities WHERE tenant = ? AND id = ?",
                (tenant, str(identity_id)),
            ).fetchone()
            if row is not None:
                conn.execute(
                    "UPDATE anonymous_identities SET last_seen_at = ? WHERE tenant = ? AND id = ?",
                    (_utcnow(), tenant, str(identity_id)),
                )
            return row

    # -- usage ledger -----------------------------------------------------------

    def get_usage_event_by_key(self, idempotency_key: str) -> sqlite3.Row | None:
        with self.transaction() as conn:
            return conn.execute(
                "SELECT * FROM usage_events WHERE idempotency_key = ?",
                (str(idempotency_key),),
            ).fetchone()

    def get_usage_event(self, event_id: uuid.UUID) -> sqlite3.Row | None:
        with self.transaction() as conn:
            return conn.execute(
                "SELECT * FROM usage_events WHERE id = ?", (str(event_id),)
            ).fetchone()

    def sum_consumed(
        self, tenant: str, owner_kind: str, owner_id: uuid.UUID, metric: str, period_start: str
    ) -> int:
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT COALESCE(SUM(quantity), 0) AS total FROM usage_events"
                " WHERE tenant = ? AND owner_kind = ? AND owner_id = ? AND metric = ?"
                " AND period_start = ? AND state = 'consumed' AND billable = 1",
                (tenant, owner_kind, str(owner_id), metric, period_start),
            ).fetchone()
            return int(row["total"])

    def get_reserved(
        self, tenant: str, owner_kind: str, owner_id: uuid.UUID, metric: str, period_start: str
    ) -> int:
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT reserved FROM usage_guard"
                " WHERE tenant = ? AND owner_kind = ? AND owner_id = ? AND metric = ? AND period_start = ?",
                (tenant, owner_kind, str(owner_id), metric, period_start),
            ).fetchone()
            return int(row["reserved"]) if row is not None else 0

    def insert_usage_event(
        self,
        *,
        tenant: str,
        event_id: uuid.UUID,
        idempotency_key: str,
        owner_kind: str,
        owner_id: uuid.UUID,
        job_id: str | None,
        metric: str,
        quantity: int,
        state: str,
        period_kind: str,
        period_start: str,
        period_end: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        now = _utcnow()
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO usage_events (tenant, id, idempotency_key, owner_kind, owner_id,"
                " job_id, metric, quantity, state, billable, period_kind, period_start,"
                " period_end, metadata, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
                (
                    tenant,
                    str(event_id),
                    str(idempotency_key),
                    owner_kind,
                    str(owner_id),
                    job_id,
                    metric,
                    int(quantity),
                    state,
                    period_kind,
                    period_start,
                    period_end,
                    json.dumps(metadata or {}),
                    now,
                    now,
                ),
            )

    def update_usage_event(
        self,
        event_id: uuid.UUID,
        *,
        state: str,
        quantity: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        with self.transaction() as conn:
            if quantity is not None:
                conn.execute(
                    "UPDATE usage_events SET quantity = ? WHERE id = ?",
                    (int(quantity), str(event_id)),
                )
            if metadata is not None:
                conn.execute(
                    "UPDATE usage_events SET metadata = ? WHERE id = ?",
                    (json.dumps(metadata), str(event_id)),
                )
            conn.execute(
                "UPDATE usage_events SET state = ?, updated_at = ? WHERE id = ?",
                (state, _utcnow(), str(event_id)),
            )

    def adjust_reserved(
        self,
        tenant: str,
        owner_kind: str,
        owner_id: uuid.UUID,
        metric: str,
        period_start: str,
        delta: int,
    ) -> None:
        # UPDATE first: SQLite evaluates CHECK on the incoming row before the
        # upsert conflict resolution, so an upsert with a negative delta would
        # fail the CHECK even when the resulting value is fine. Two statements
        # inside the same transaction are equally atomic — and an INSERT for a
        # negative delta (a release without a hold) then rightly fails CHECK.
        with self.transaction() as conn:
            cursor = conn.execute(
                "UPDATE usage_guard SET reserved = reserved + ?"
                " WHERE tenant = ? AND owner_kind = ? AND owner_id = ? AND metric = ? AND period_start = ?",
                (int(delta), tenant, owner_kind, str(owner_id), metric, period_start),
            )
            if cursor.rowcount == 0:
                conn.execute(
                    "INSERT INTO usage_guard (tenant, owner_kind, owner_id, metric, period_start, reserved)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (tenant, owner_kind, str(owner_id), metric, period_start, int(delta)),
                )
