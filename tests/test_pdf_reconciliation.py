"""Server-side PDF credit settlement without browser polling."""
from __future__ import annotations

import asyncio
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from app.credits.policy import CreditCostPolicy
from app.credits.quotes import CreditQuoteService
from app.pdf_reconciliation import (
    reconcile_pdf_credit_reservations,
    run_pdf_reconciliation_loop,
)
from app.pdf_translation_bridge import PdfTranslationError
from app.saas_setup import SaasContext
from saas.entitlements import EntitlementService
from saas.principals import Principal
from saas.storage import SaasStore
from saas.usage import QuotaService

TENANT = "t"


class PdfCreditReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.store = SaasStore(Path(self._tmp.name) / "saas.db")
        quota_service = QuotaService(self.store)
        policy = CreditCostPolicy.from_config(
            config={
                "version": "credits-v1",
                "quote_ttl_seconds": 900,
                "denomination_eur": "0.001",
                "actions": {"pdf_translation": {"minimum_credits": 20}},
            },
        )
        quote_service = CreditQuoteService(
            store=self.store,
            quota_service=quota_service,
            policy=policy,
        )
        self.ctx = SaasContext(
            store=self.store,
            entitlement_service=EntitlementService({}),
            quota_service=quota_service,
            signing_secret="test",
            tenant=TENANT,
            token_verifier=None,
            user_plan="free",
            credit_policy=policy,
            credit_quote_service=quote_service,
        )
        self.principal = Principal(
            tenant=TENANT,
            kind="user",
            id=uuid.uuid4(),
            plan_code="free",
        )
        self.operation_id = str(uuid.uuid4())
        quote = quote_service.create(
            self.principal,
            action="pdf_translation",
            payload_hash="payload",
            pricing_inputs={"pages": 2, "source_characters": 3393},
            basis="pages+source_characters",
            basis_quantity=2,
            quoted_credits=100,
        )
        self.reservation = quote_service.confirm(
            self.principal,
            quote_id=quote.id,
            operation_id=self.operation_id,
            action="pdf_translation",
            payload_hash="payload",
            credit_limit=300,
            period_kind="month",
        )
        self._context_patches = [
            patch("app.pdf_reconciliation.get_saas_context", return_value=self.ctx),
            patch("app.credits.pdf_translation.get_saas_context", return_value=self.ctx),
        ]
        for context_patch in self._context_patches:
            context_patch.start()

    def tearDown(self) -> None:
        for context_patch in reversed(self._context_patches):
            context_patch.stop()
        self.store.close()
        self._tmp.cleanup()

    def _state(self) -> str:
        return str(self.store.get_usage_event(self.reservation.id)["state"])

    def test_completed_job_is_consumed_without_browser_polling(self) -> None:
        with patch(
            "app.pdf_reconciliation.get_pdf_request",
            return_value={"request_id": self.operation_id, "state": "completed"},
        ):
            settled = reconcile_pdf_credit_reservations()

        self.assertEqual(settled, 1)
        self.assertEqual(self._state(), "consumed")

    def test_missing_job_before_grace_period_remains_reserved(self) -> None:
        event = self.store.get_usage_event(self.reservation.id)
        created_at = datetime.fromisoformat(str(event["created_at"]))
        with patch(
            "app.pdf_reconciliation.get_pdf_request",
            side_effect=PdfTranslationError("not found", status_code=404),
        ):
            settled = reconcile_pdf_credit_reservations(
                now=created_at + timedelta(hours=23),
                missing_grace_s=24 * 60 * 60,
            )

        self.assertEqual(settled, 0)
        self.assertEqual(self._state(), "reserved")

    def test_missing_job_after_grace_period_is_released(self) -> None:
        event = self.store.get_usage_event(self.reservation.id)
        created_at = datetime.fromisoformat(str(event["created_at"]))
        with patch(
            "app.pdf_reconciliation.get_pdf_request",
            side_effect=PdfTranslationError("not found", status_code=404),
        ):
            settled = reconcile_pdf_credit_reservations(
                now=created_at + timedelta(hours=25),
                missing_grace_s=24 * 60 * 60,
            )

        self.assertEqual(settled, 1)
        self.assertEqual(self._state(), "released")

    def test_service_outage_remains_reserved(self) -> None:
        with patch(
            "app.pdf_reconciliation.get_pdf_request",
            side_effect=PdfTranslationError("unreachable", status_code=502),
        ):
            settled = reconcile_pdf_credit_reservations(
                now=datetime.now(timezone.utc) + timedelta(days=30),
                missing_grace_s=0,
            )

        self.assertEqual(settled, 0)
        self.assertEqual(self._state(), "reserved")


class PdfReconciliationLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_loop_runs_a_credit_pass_before_sleeping(self) -> None:
        with (
            patch("app.pdf_reconciliation.reconcile_pdf_credit_reservations") as reconcile,
            patch(
                "app.pdf_reconciliation.asyncio.sleep",
                new=AsyncMock(side_effect=asyncio.CancelledError),
            ),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await run_pdf_reconciliation_loop()
        reconcile.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
