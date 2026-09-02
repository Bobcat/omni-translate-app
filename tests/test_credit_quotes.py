from __future__ import annotations

import json
import threading
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from app.credits.policy import CreditCostPolicy
from app.credits.quotes import CREDITS_METRIC, CreditQuoteService
from saas.errors import CREDITS_EXHAUSTED, QUOTE_EXPIRED, QUOTE_MISMATCH, SaasError
from saas.principals import Principal
from saas.storage import SaasStore
from saas.usage import QuotaService


UTC = timezone.utc
NOW = datetime(2026, 8, 31, 12, 0, tzinfo=UTC)


def _policy(*, version: str = "credits-v1", ttl: int = 900) -> CreditCostPolicy:
    return CreditCostPolicy.from_config(
        config={
            "version": version,
            "quote_ttl_seconds": ttl,
            "denomination_eur": "0.001",
            "actions": {"pdf_translation": {"minimum_credits": 20}},
        },
    )


def _principal() -> Principal:
    return Principal(tenant="t", kind="user", id=uuid.uuid4(), plan_code="free")


class CreditQuoteServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.store = SaasStore(Path(self._tmp.name) / "saas.db")
        self.quota = QuotaService(self.store)
        self.service = CreditQuoteService(
            store=self.store,
            quota_service=self.quota,
            policy=_policy(),
        )
        self.principal = _principal()

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def _quote(self, *, now: datetime = NOW, quoted_credits: int = 650):
        return self.service.create(
            self.principal,
            action="pdf_translation",
            payload_hash="payload-a",
            pricing_inputs={"pages": 15, "source_characters": 32940},
            basis="pages+source_characters",
            basis_quantity=15,
            quoted_credits=quoted_credits,
            now=now,
        )

    def _confirm(
        self,
        quote_id: uuid.UUID,
        *,
        operation_id: str = "operation-a",
        payload_hash: str = "payload-a",
        now: datetime = NOW,
        limit: int = 3000,
    ):
        return self.service.confirm(
            self.principal,
            quote_id=quote_id,
            operation_id=operation_id,
            action="pdf_translation",
            payload_hash=payload_hash,
            credit_limit=limit,
            period_kind="month",
            now=now,
        )

    def test_quote_persists_binding_context(self) -> None:
        quote = self._quote()
        row = self.store.get_credit_quote(quote.id)

        self.assertEqual(quote.quoted_credits, 650)
        self.assertEqual(row["owner_id"], str(self.principal.id))
        self.assertEqual(row["cost_policy_version"], "credits-v1")
        self.assertEqual(json.loads(row["pricing_inputs"])["source_characters"], 32940)

    def test_quote_survives_store_reopen_before_confirmation(self) -> None:
        quote = self._quote()
        path = Path(self._tmp.name) / "saas.db"
        self.store.close()
        self.store = SaasStore(path)
        self.quota = QuotaService(self.store)
        self.service = CreditQuoteService(
            store=self.store,
            quota_service=self.quota,
            policy=_policy(),
        )

        reservation = self._confirm(quote.id)

        self.assertEqual(reservation.quantity, 650)

    def test_confirmation_reserves_exact_quote_and_is_idempotent(self) -> None:
        quote = self._quote()

        first = self._confirm(quote.id)
        replay = self._confirm(quote.id)
        usage = self.quota.get_usage(self.principal, CREDITS_METRIC, "month", now=NOW)

        self.assertEqual(first.id, replay.id)
        self.assertEqual((usage.reserved, usage.consumed), (650, 0))
        event = self.store.get_usage_event(first.id)
        metadata = json.loads(event["metadata"])
        self.assertEqual(metadata["quote_id"], str(quote.id))
        self.assertEqual(metadata["quoted_credits"], 650)

    def test_confirmed_quote_cannot_bind_another_operation(self) -> None:
        quote = self._quote()
        self._confirm(quote.id)

        with self.assertRaises(SaasError) as caught:
            self._confirm(quote.id, operation_id="operation-b")

        self.assertEqual(caught.exception.code, QUOTE_MISMATCH)

    def test_operation_id_cannot_bind_another_quote_or_payload(self) -> None:
        first = self._quote()
        self._confirm(first.id)
        second = self.service.create(
            self.principal,
            action="pdf_translation",
            payload_hash="payload-b",
            pricing_inputs={"pages": 15, "source_characters": 32940},
            basis="pages+source_characters",
            basis_quantity=15,
            quoted_credits=650,
            now=NOW,
        )

        with self.assertRaises(SaasError) as caught:
            self._confirm(second.id, payload_hash="payload-b")

        self.assertEqual(caught.exception.code, QUOTE_MISMATCH)
        usage = self.quota.get_usage(self.principal, CREDITS_METRIC, "month", now=NOW)
        self.assertEqual(usage.reserved, 650)

    def test_payload_change_rejects_before_reservation(self) -> None:
        quote = self._quote()

        with self.assertRaises(SaasError) as caught:
            self._confirm(quote.id, payload_hash="payload-b")

        self.assertEqual(caught.exception.code, QUOTE_MISMATCH)
        usage = self.quota.get_usage(self.principal, CREDITS_METRIC, "month", now=NOW)
        self.assertEqual(usage.reserved, 0)

    def test_other_owner_cannot_use_quote(self) -> None:
        quote = self._quote()
        other_service = self.service
        other = _principal()

        with self.assertRaises(SaasError) as caught:
            other_service.confirm(
                other,
                quote_id=quote.id,
                operation_id="operation-a",
                action="pdf_translation",
                payload_hash="payload-a",
                credit_limit=3000,
                period_kind="month",
                now=NOW,
            )

        self.assertEqual(caught.exception.code, QUOTE_MISMATCH)

    def test_expired_quote_cannot_be_confirmed(self) -> None:
        quote = self._quote()

        with self.assertRaises(SaasError) as caught:
            self._confirm(quote.id, now=NOW + timedelta(seconds=900))

        self.assertEqual(caught.exception.code, QUOTE_EXPIRED)
        self.assertEqual(self.store.get_credit_quote(quote.id)["state"], "expired")

    def test_new_quote_after_expiry_requires_new_confirmation(self) -> None:
        expired = self._quote()
        with self.assertRaises(SaasError):
            self._confirm(expired.id, now=NOW + timedelta(seconds=900))

        replacement = self._quote(now=NOW + timedelta(seconds=900))
        reservation = self._confirm(
            replacement.id,
            now=NOW + timedelta(seconds=900),
            operation_id="operation-b",
        )

        self.assertEqual(reservation.quantity, 650)
        self.assertNotEqual(expired.id, replacement.id)

    def test_policy_change_does_not_reprice_existing_quote(self) -> None:
        quote = self._quote()
        changed_service = CreditQuoteService(
            store=self.store,
            quota_service=self.quota,
            policy=_policy(version="credits-v2"),
        )

        reservation = changed_service.confirm(
            self.principal,
            quote_id=quote.id,
            operation_id="operation-a",
            action="pdf_translation",
            payload_hash="payload-a",
            credit_limit=3000,
            period_kind="month",
            now=NOW,
        )

        self.assertEqual(reservation.quantity, 650)
        event = self.store.get_usage_event(reservation.id)
        self.assertEqual(json.loads(event["metadata"])["cost_policy_version"], "credits-v1")

    def test_insufficient_balance_reports_required_and_available(self) -> None:
        quote = self._quote()

        with self.assertRaises(SaasError) as caught:
            self._confirm(quote.id, limit=300)

        self.assertEqual(caught.exception.code, CREDITS_EXHAUSTED)
        self.assertEqual(caught.exception.details["required"], 650)
        self.assertEqual(caught.exception.details["available"], 300)

    def test_actual_usage_metadata_cannot_change_consumed_credits(self) -> None:
        quote = self._quote()
        reservation = self._confirm(quote.id)

        self.service.consume(
            self.principal,
            quote.id,
            actual_usage={"pages": 18, "source_characters": 41000},
        )
        usage = self.quota.get_usage(self.principal, CREDITS_METRIC, "month", now=NOW)
        event = self.store.get_usage_event(reservation.id)

        self.assertEqual((usage.reserved, usage.consumed), (0, 650))
        self.assertEqual(json.loads(event["metadata"])["actual_usage"]["pages"], 18)

    def test_technical_failure_releases_exact_reservation(self) -> None:
        quote = self._quote()
        self._confirm(quote.id)

        self.service.release(self.principal, quote.id, reason="recognized technical failure")
        usage = self.quota.get_usage(self.principal, CREDITS_METRIC, "month", now=NOW)

        self.assertEqual((usage.reserved, usage.consumed), (0, 0))

    def test_concurrent_confirmations_cannot_overspend(self) -> None:
        quotes = [self._quote(quoted_credits=200) for _ in range(3)]
        barrier = threading.Barrier(3)
        successes: list[object] = []
        failures: list[SaasError] = []
        lock = threading.Lock()

        def worker(index: int) -> None:
            try:
                barrier.wait(timeout=5)
                reservation = self._confirm(
                    quotes[index].id,
                    operation_id=f"operation-{index}",
                    limit=300,
                )
                with lock:
                    successes.append(reservation)
            except SaasError as exc:
                with lock:
                    failures.append(exc)

        threads = [threading.Thread(target=worker, args=(index,)) for index in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        usage = self.quota.get_usage(self.principal, CREDITS_METRIC, "month", now=NOW)
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(failures), 2)
        self.assertTrue(all(exc.code == CREDITS_EXHAUSTED for exc in failures))
        self.assertEqual(usage.reserved, 200)


if __name__ == "__main__":
    unittest.main()
