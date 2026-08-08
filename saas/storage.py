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

_USAGE_EVENTS_TABLE_SQL = """
CREATE TABLE usage_events (
    tenant TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
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
    updated_at TEXT NOT NULL,
    UNIQUE (tenant, owner_kind, owner_id, idempotency_key)
);
"""


SCHEMA = f"""
CREATE TABLE IF NOT EXISTS identities (
    tenant TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'anonymous',
    external_subject TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'active'
);
-- One identity per external auth subject (e.g. an identity provider's user id);
-- anonymous rows carry no subject and are exempt from the uniqueness rule.
CREATE UNIQUE INDEX IF NOT EXISTS idx_identities_external_subject
    ON identities (tenant, external_subject) WHERE external_subject IS NOT NULL;
{_USAGE_EVENTS_TABLE_SQL.replace("CREATE TABLE usage_events", "CREATE TABLE IF NOT EXISTS usage_events")}
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
CREATE TABLE IF NOT EXISTS resource_owners (
    tenant TEXT NOT NULL,
    resource_kind TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    payload_hash TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant, resource_kind, resource_id)
);
-- Host-neutral recovery record for workflows whose authoritative usage can
-- only be measured after an upstream preparation stage.
CREATE TABLE IF NOT EXISTS quota_operations (
    tenant TEXT NOT NULL,
    operation_kind TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    entitlement_snapshot TEXT NOT NULL,
    state TEXT NOT NULL,
    counting_version TEXT,
    quantity INTEGER CHECK (quantity IS NULL OR quantity >= 0),
    error_code TEXT,
    error_details TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant, operation_kind, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_quota_operations_reconciliation
    ON quota_operations (tenant, operation_kind, state, created_at);
"""


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _migrate_identities(conn: sqlite3.Connection) -> None:
    """Pre-user DBs carry ``anonymous_identities`` without kind/subject columns;
    fold it into ``identities`` so existing anonymous principals keep working.
    Idempotent; a fresh database has neither table and skips straight to SCHEMA."""
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "anonymous_identities" in tables and "identities" not in tables:
        conn.execute("ALTER TABLE anonymous_identities RENAME TO identities")
        tables.add("identities")  # the snapshot predates the rename
    if "identities" in tables:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(identities)")}
        if "kind" not in columns:
            conn.execute("ALTER TABLE identities ADD COLUMN kind TEXT NOT NULL DEFAULT 'anonymous'")
        if "external_subject" not in columns:
            conn.execute("ALTER TABLE identities ADD COLUMN external_subject TEXT")


def _migrate_usage_event_idempotency(conn: sqlite3.Connection) -> None:
    """Replace the original global idempotency-key constraint with an
    owner-scoped one while preserving existing ledger rows."""
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "usage_events" not in tables:
        return
    has_global_key_index = False
    for index in conn.execute("PRAGMA index_list(usage_events)"):
        if not int(index[2]):
            continue
        columns = [row[2] for row in conn.execute(f"PRAGMA index_info('{index[1]}')")]
        if columns == ["idempotency_key"]:
            has_global_key_index = True
            break
    if not has_global_key_index:
        return

    legacy_table = "usage_events_global_idempotency"
    columns = (
        "tenant, id, idempotency_key, owner_kind, owner_id, job_id, metric, quantity,"
        " state, billable, period_kind, period_start, period_end, metadata, created_at, updated_at"
    )
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(f"ALTER TABLE usage_events RENAME TO {legacy_table}")
        conn.execute(_USAGE_EVENTS_TABLE_SQL)
        conn.execute(
            f"INSERT INTO usage_events ({columns}) SELECT {columns} FROM {legacy_table}"
        )
        conn.execute(f"DROP TABLE {legacy_table}")
    except Exception:
        conn.rollback()
        raise
    else:
        conn.commit()


def _migrate_resource_owners(conn: sqlite3.Connection) -> None:
    """Add durable payload binding to databases created before operation recovery."""
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "resource_owners" not in tables:
        return
    columns = {row[1] for row in conn.execute("PRAGMA table_info(resource_owners)")}
    if "payload_hash" not in columns:
        conn.execute("ALTER TABLE resource_owners ADD COLUMN payload_hash TEXT")


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
                _migrate_identities(self._conn)
                _migrate_usage_event_idempotency(self._conn)
                self._conn.executescript(SCHEMA)
                _migrate_resource_owners(self._conn)
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

    # -- identities -----------------------------------------------------------

    def create_identity(self, tenant: str) -> uuid.UUID:
        identity_id = uuid.uuid4()
        now = _utcnow()
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO identities (tenant, id, created_at, last_seen_at, status)"
                " VALUES (?, ?, ?, ?, 'active')",
                (tenant, str(identity_id), now, now),
            )
        return identity_id

    def get_identity(self, tenant: str, identity_id: uuid.UUID) -> sqlite3.Row | None:
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM identities WHERE tenant = ? AND id = ?",
                (tenant, str(identity_id)),
            ).fetchone()
            if row is not None:
                conn.execute(
                    "UPDATE identities SET last_seen_at = ? WHERE tenant = ? AND id = ?",
                    (_utcnow(), tenant, str(identity_id)),
                )
            return row

    def get_or_create_external_identity(self, tenant: str, subject: str) -> uuid.UUID:
        """The stable identity for an external auth subject (a user id from the
        identity provider): the existing row wins, else a fresh user-kind
        identity. The partial unique index plus the write lock close the race."""
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT id FROM identities WHERE tenant = ? AND external_subject = ?",
                (tenant, str(subject)),
            ).fetchone()
            if row is not None:
                conn.execute(
                    "UPDATE identities SET last_seen_at = ? WHERE tenant = ? AND external_subject = ?",
                    (_utcnow(), tenant, str(subject)),
                )
                return uuid.UUID(row["id"])
            identity_id = uuid.uuid4()
            now = _utcnow()
            conn.execute(
                "INSERT INTO identities (tenant, id, kind, external_subject, created_at,"
                " last_seen_at, status) VALUES (?, ?, 'user', ?, ?, ?, 'active')",
                (tenant, str(identity_id), str(subject), now, now),
            )
            return identity_id

    # -- resource ownership ---------------------------------------------------

    def claim_resource_owner(
        self,
        tenant: str,
        resource_kind: str,
        resource_id: str,
        owner_kind: str,
        owner_id: uuid.UUID,
        payload_hash: str,
    ) -> bool:
        """Claim a host resource once; require the same owner and payload on replay."""
        with self.transaction() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO resource_owners"
                " (tenant, resource_kind, resource_id, owner_kind, owner_id, payload_hash, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    tenant,
                    str(resource_kind),
                    str(resource_id),
                    owner_kind,
                    str(owner_id),
                    str(payload_hash),
                    _utcnow(),
                ),
            )
            row = conn.execute(
                "SELECT owner_kind, owner_id, payload_hash FROM resource_owners"
                " WHERE tenant = ? AND resource_kind = ? AND resource_id = ?",
                (tenant, str(resource_kind), str(resource_id)),
            ).fetchone()
        return bool(
            row is not None
            and row["owner_kind"] == owner_kind
            and row["owner_id"] == str(owner_id)
            and row["payload_hash"] == str(payload_hash)
        )

    def resource_is_owned_by(
        self,
        tenant: str,
        resource_kind: str,
        resource_id: str,
        owner_kind: str,
        owner_id: uuid.UUID,
    ) -> bool:
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT 1 FROM resource_owners WHERE tenant = ? AND resource_kind = ?"
                " AND resource_id = ? AND owner_kind = ? AND owner_id = ?",
                (tenant, str(resource_kind), str(resource_id), owner_kind, str(owner_id)),
            ).fetchone()
        return row is not None

    # -- quota operation recovery --------------------------------------------

    def create_quota_operation(
        self,
        *,
        tenant: str,
        operation_kind: str,
        operation_id: str,
        owner_kind: str,
        owner_id: uuid.UUID,
        metric: str,
        entitlement_snapshot: dict[str, Any],
    ) -> sqlite3.Row:
        """Create once and return the original immutable operation snapshot."""
        now = _utcnow()
        with self.transaction() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO quota_operations"
                " (tenant, operation_kind, operation_id, owner_kind, owner_id, metric,"
                " entitlement_snapshot, state, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)",
                (
                    tenant,
                    str(operation_kind),
                    str(operation_id),
                    owner_kind,
                    str(owner_id),
                    str(metric),
                    json.dumps(entitlement_snapshot),
                    now,
                    now,
                ),
            )
            row = conn.execute(
                "SELECT * FROM quota_operations WHERE tenant = ?"
                " AND operation_kind = ? AND operation_id = ?",
                (tenant, str(operation_kind), str(operation_id)),
            ).fetchone()
        if row is None:
            raise RuntimeError("quota operation was not persisted")
        return row

    def get_quota_operation(
        self,
        tenant: str,
        operation_kind: str,
        operation_id: str,
    ) -> sqlite3.Row | None:
        with self.transaction() as conn:
            return conn.execute(
                "SELECT * FROM quota_operations WHERE tenant = ?"
                " AND operation_kind = ? AND operation_id = ?",
                (tenant, str(operation_kind), str(operation_id)),
            ).fetchone()

    def list_quota_operations(
        self,
        tenant: str,
        *,
        operation_kind: str,
        states: tuple[str, ...],
        limit: int = 100,
    ) -> list[sqlite3.Row]:
        if not states:
            return []
        placeholders = ",".join("?" for _ in states)
        with self.transaction() as conn:
            return list(
                conn.execute(
                    "SELECT * FROM quota_operations WHERE tenant = ?"
                    " AND operation_kind = ?"
                    f" AND state IN ({placeholders})"
                    " ORDER BY created_at, operation_id LIMIT ?",
                    (
                        tenant,
                        str(operation_kind),
                        *[str(state) for state in states],
                        max(1, int(limit)),
                    ),
                ).fetchall()
            )

    def update_quota_operation(
        self,
        *,
        tenant: str,
        operation_kind: str,
        operation_id: str,
        state: str,
        counting_version: str | None = None,
        quantity: int | None = None,
        error_code: str | None = None,
        error_details: dict[str, Any] | None = None,
    ) -> None:
        with self.transaction() as conn:
            conn.execute(
                "UPDATE quota_operations SET state = ?, counting_version = COALESCE(?, counting_version),"
                " quantity = COALESCE(?, quantity), error_code = ?, error_details = ?, updated_at = ?"
                " WHERE tenant = ? AND operation_kind = ? AND operation_id = ?",
                (
                    str(state),
                    counting_version,
                    quantity,
                    error_code,
                    json.dumps(error_details) if error_details is not None else None,
                    _utcnow(),
                    tenant,
                    str(operation_kind),
                    str(operation_id),
                ),
            )

    # -- usage ledger -----------------------------------------------------------

    def get_usage_event_by_key(
        self,
        tenant: str,
        owner_kind: str,
        owner_id: uuid.UUID,
        idempotency_key: str,
    ) -> sqlite3.Row | None:
        with self.transaction() as conn:
            return conn.execute(
                "SELECT * FROM usage_events WHERE tenant = ? AND owner_kind = ?"
                " AND owner_id = ? AND idempotency_key = ?",
                (tenant, owner_kind, str(owner_id), str(idempotency_key)),
            ).fetchone()

    def get_usage_event(self, event_id: uuid.UUID) -> sqlite3.Row | None:
        with self.transaction() as conn:
            return conn.execute(
                "SELECT * FROM usage_events WHERE id = ?", (str(event_id),)
            ).fetchone()

    def get_usage_event_by_job_id(
        self,
        tenant: str,
        job_id: str,
        *,
        metric: str | None = None,
    ) -> sqlite3.Row | None:
        """The usage event linked to a host job (e.g. an upstream request id)."""
        with self.transaction() as conn:
            if metric is not None:
                return conn.execute(
                    "SELECT * FROM usage_events WHERE tenant = ? AND job_id = ? AND metric = ?",
                    (tenant, str(job_id), str(metric)),
                ).fetchone()
            return conn.execute(
                "SELECT * FROM usage_events WHERE tenant = ? AND job_id = ?",
                (tenant, str(job_id)),
            ).fetchone()

    def list_usage_events(
        self,
        tenant: str,
        *,
        metric: str,
        state: str,
        limit: int = 100,
    ) -> list[sqlite3.Row]:
        """Oldest usage events matching one metric and lifecycle state."""
        with self.transaction() as conn:
            return list(
                conn.execute(
                    "SELECT * FROM usage_events WHERE tenant = ? AND metric = ? AND state = ?"
                    " ORDER BY created_at, id LIMIT ?",
                    (tenant, str(metric), str(state), max(1, int(limit))),
                ).fetchall()
            )

    def attach_job_to_usage_event(self, event_id: uuid.UUID, job_id: str) -> None:
        """Link an event to the host job id, which some flows only learn after
        the reservation exists (e.g. the upstream request id comes back from
        the submit that had to be reserved first)."""
        with self.transaction() as conn:
            conn.execute(
                "UPDATE usage_events SET job_id = ?, updated_at = ? WHERE id = ?",
                (str(job_id), _utcnow(), str(event_id)),
            )

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
