from __future__ import annotations

import sqlite3
import threading
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from saas.errors import PERIOD_QUOTA_EXCEEDED, USAGE_IDEMPOTENCY_CONFLICT, SaasError
from saas.principals import Principal
from saas.storage import SaasStore
from saas.usage import QuotaService

UTC = timezone.utc
METRIC = "pdf_translation.pages"
NOW = datetime(2026, 7, 15, 12, 0, tzinfo=UTC)


def _principal() -> Principal:
    return Principal(tenant="t", kind="anonymous", id=uuid.uuid4(), plan_code="free")


class QuotaServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.store = SaasStore(Path(self._tmp.name) / "saas.db")
        self.quota = QuotaService(self.store)
        self.principal = _principal()

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def _reserve(self, quantity: int, *, limit: int = 12, key: str | None = None, now=NOW):
        return self.quota.reserve(
            self.principal,
            metric=METRIC,
            quantity=quantity,
            limit=limit,
            period_kind="month",
            job_id="job-1",
            idempotency_key=key or uuid.uuid4().hex,
            now=now,
        )

    def test_reserve_under_limit(self) -> None:
        reservation = self._reserve(6)
        self.assertEqual(reservation.state, "reserved")
        summary = self.quota.get_usage(self.principal, METRIC, "month", now=NOW)
        self.assertEqual((summary.reserved, summary.consumed), (6, 0))
        self.assertEqual(summary.period_start, "2026-07-01T00:00:00+00:00")

    def test_reserve_over_limit_rejected(self) -> None:
        self._reserve(10)
        with self.assertRaises(SaasError) as ctx:
            self._reserve(3)
        self.assertEqual(ctx.exception.code, PERIOD_QUOTA_EXCEEDED)
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertEqual(ctx.exception.details["limit"], 12)
        self.assertEqual(ctx.exception.details["reserved"], 10)

    def test_same_idempotency_key_does_not_double_reserve(self) -> None:
        first = self._reserve(6, key="job-1:pages")
        second = self._reserve(6, key="job-1:pages")
        self.assertEqual(first.id, second.id)
        summary = self.quota.get_usage(self.principal, METRIC, "month", now=NOW)
        self.assertEqual(summary.reserved, 6)

    def test_same_key_with_different_quantity_conflicts(self) -> None:
        self._reserve(6, key="job-1:pages")
        with self.assertRaises(SaasError) as ctx:
            self._reserve(7, key="job-1:pages")
        self.assertEqual(ctx.exception.code, USAGE_IDEMPOTENCY_CONFLICT)
        self.assertEqual(ctx.exception.status_code, 409)

    def test_same_key_is_isolated_per_principal_and_tenant(self) -> None:
        self._reserve(6, key="shared-operation")
        other_owner = _principal()
        other_tenant = Principal(
            tenant="other-tenant",
            kind="anonymous",
            id=uuid.uuid4(),
            plan_code="free",
        )
        for principal in (other_owner, other_tenant):
            reservation = self.quota.reserve(
                principal,
                metric=METRIC,
                quantity=4,
                limit=12,
                period_kind="month",
                job_id="job-other",
                idempotency_key="shared-operation",
                now=NOW,
            )
            self.assertEqual(reservation.quantity, 4)
            summary = self.quota.get_usage(principal, METRIC, "month", now=NOW)
            self.assertEqual(summary.reserved, 4)

    def test_consume_moves_reserved_to_consumed(self) -> None:
        reservation = self._reserve(10)
        self.quota.consume(reservation.id)
        summary = self.quota.get_usage(self.principal, METRIC, "month", now=NOW)
        self.assertEqual((summary.reserved, summary.consumed), (0, 10))

    def test_consume_with_actual_quantity(self) -> None:
        reservation = self._reserve(10)
        self.quota.consume(reservation.id, actual_quantity=7)
        summary = self.quota.get_usage(self.principal, METRIC, "month", now=NOW)
        self.assertEqual((summary.reserved, summary.consumed), (0, 7))

    def test_service_failure_releases_and_frees_quota(self) -> None:
        reservation = self._reserve(10)
        self.quota.release(reservation.id, "translation-services unreachable")
        summary = self.quota.get_usage(self.principal, METRIC, "month", now=NOW)
        self.assertEqual((summary.reserved, summary.consumed), (0, 0))
        # The released budget is spendable again.
        self._reserve(12)

    def test_double_finalize_is_a_safe_noop(self) -> None:
        reservation = self._reserve(10)
        self.quota.consume(reservation.id)
        self.quota.consume(reservation.id)
        self.quota.release(reservation.id, "too late")
        summary = self.quota.get_usage(self.principal, METRIC, "month", now=NOW)
        self.assertEqual((summary.reserved, summary.consumed), (0, 10))

    def test_unknown_reservation_rejected(self) -> None:
        with self.assertRaises(SaasError) as ctx:
            self.quota.consume(uuid.uuid4())
        self.assertEqual(ctx.exception.status_code, 404)

    def test_usage_is_isolated_per_period(self) -> None:
        self._reserve(10)
        february = datetime(2026, 2, 15, 12, 0, tzinfo=UTC)
        summary = self.quota.get_usage(self.principal, METRIC, "month", now=february)
        self.assertEqual((summary.reserved, summary.consumed), (0, 0))

    def test_usage_is_isolated_per_principal(self) -> None:
        self._reserve(10)
        other = self.quota.get_usage(_principal(), METRIC, "month", now=NOW)
        self.assertEqual((other.reserved, other.consumed), (0, 0))

    def test_concurrent_reserves_cannot_overspend(self) -> None:
        barrier = threading.Barrier(8)
        successes: list[object] = []
        failures: list[Exception] = []
        lock = threading.Lock()

        def worker(index: int) -> None:
            try:
                barrier.wait(timeout=5)
                reservation = self._reserve(2, key=f"worker-{index}")
                with lock:
                    successes.append(reservation)
            except SaasError as exc:
                with lock:
                    failures.append(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)

        # 8 workers x 2 pages against a limit of 12: at most 6 can succeed.
        self.assertLessEqual(len(successes), 6)
        self.assertGreater(len(failures), 0)
        summary = self.quota.get_usage(self.principal, METRIC, "month", now=NOW)
        self.assertEqual(summary.reserved, 2 * len(successes))
        self.assertLessEqual(summary.reserved, 12)


class SaasStoreMigrationTests(unittest.TestCase):
    def test_global_idempotency_schema_is_migrated_without_losing_events(self) -> None:
        owner_id = uuid.uuid4()
        event_id = uuid.uuid4()
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "saas.db"
            legacy = sqlite3.connect(path)
            legacy.execute(
                "CREATE TABLE usage_events (tenant TEXT NOT NULL, id TEXT PRIMARY KEY,"
                " idempotency_key TEXT NOT NULL UNIQUE, owner_kind TEXT NOT NULL,"
                " owner_id TEXT NOT NULL, job_id TEXT, metric TEXT NOT NULL,"
                " quantity INTEGER NOT NULL, state TEXT NOT NULL, billable INTEGER NOT NULL,"
                " period_kind TEXT, period_start TEXT, period_end TEXT, metadata TEXT,"
                " created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
            )
            legacy.execute(
                "INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "t", str(event_id), "shared-key", "anonymous", str(owner_id), "job-1",
                    METRIC, 3, "consumed", 1, "month", "2026-07-01T00:00:00+00:00",
                    "2026-08-01T00:00:00+00:00", "{}", "now", "now",
                ),
            )
            legacy.commit()
            legacy.close()

            store = SaasStore(path)
            carried = store.get_usage_event_by_key("t", "anonymous", owner_id, "shared-key")
            other = _principal()
            reservation = QuotaService(store).reserve(
                other,
                metric=METRIC,
                quantity=4,
                limit=12,
                period_kind="month",
                idempotency_key="shared-key",
                now=NOW,
            )
            store.close()

        self.assertEqual(carried["id"], str(event_id))
        self.assertEqual(reservation.quantity, 4)


if __name__ == "__main__":
    unittest.main()
