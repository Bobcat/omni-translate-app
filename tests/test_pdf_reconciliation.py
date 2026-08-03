"""Server-side PDF quota settlement without browser polling."""
from __future__ import annotations

import asyncio
import json
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from app.pdf_quota import PAGES_METRIC
from app.pdf_reconciliation import reconcile_pdf_reservations, run_pdf_reconciliation_loop
from app.pdf_translation_bridge import PdfTranslationError
from app.saas_setup import SaasContext
from saas.entitlements import EntitlementService
from saas.principals import Principal
from saas.storage import SaasStore
from saas.usage import QuotaService

TENANT = "t"


class PdfReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.store = SaasStore(Path(self._tmp.name) / "saas.db")
        self.ctx = SaasContext(
            store=self.store,
            entitlement_service=EntitlementService({}),
            quota_service=QuotaService(self.store),
            signing_secret="test",
            tenant=TENANT,
            token_verifier=None,
            user_plan="free",
        )
        self.principal = Principal(
            tenant=TENANT,
            kind="user",
            id=uuid.uuid4(),
            plan_code="free",
        )
        self.operation_id = str(uuid.uuid4())
        self.reservation = self.ctx.quota_service.reserve(
            self.principal,
            metric=PAGES_METRIC,
            quantity=5,
            limit=50,
            period_kind="month",
            job_id=self.operation_id,
            idempotency_key=f"pdf-submit:{self.operation_id}",
        )
        self._context_patch = patch(
            "app.pdf_reconciliation.get_saas_context",
            return_value=self.ctx,
        )
        self._quota_context_patch = patch(
            "app.pdf_quota.get_saas_context",
            return_value=self.ctx,
        )
        self._context_patch.start()
        self._quota_context_patch.start()

    def tearDown(self) -> None:
        self._quota_context_patch.stop()
        self._context_patch.stop()
        self.store.close()
        self._tmp.cleanup()

    def _state(self) -> str:
        return str(self.store.get_usage_event(self.reservation.id)["state"])

    def _metadata(self) -> dict:
        event = self.store.get_usage_event(self.reservation.id)
        return json.loads(str(event["metadata"]))

    def _envelope(self, state: str, *, code: str | None = None) -> dict:
        envelope = {"request_id": self.operation_id, "state": state}
        if code is not None:
            envelope["error"] = {"code": code, "message": code}
        return envelope

    def _reconcile(self, response: dict) -> int:
        with patch("app.pdf_reconciliation.get_pdf_request", return_value=response):
            return reconcile_pdf_reservations()

    def test_completed_job_is_consumed_without_browser_polling(self) -> None:
        self.assertEqual(self._reconcile(self._envelope("completed")), 1)
        self.assertEqual(self._state(), "consumed")

    def test_cancelled_job_is_consumed(self) -> None:
        self.assertEqual(self._reconcile(self._envelope("cancelled")), 1)
        self.assertEqual(self._state(), "consumed")

    def test_restart_failure_is_released(self) -> None:
        self.assertEqual(
            self._reconcile(self._envelope("failed", code="REQUEST_INTERRUPTED_BY_RESTART")),
            1,
        )
        self.assertEqual(self._state(), "released")

    def test_unknown_failure_is_consumed(self) -> None:
        self.assertEqual(self._reconcile(self._envelope("failed", code="INPUT_REJECTED")), 1)
        self.assertEqual(self._state(), "consumed")

    def test_running_job_remains_reserved(self) -> None:
        self.assertEqual(self._reconcile(self._envelope("running")), 0)
        self.assertEqual(self._state(), "reserved")

    def test_expired_artifact_does_not_change_completed_settlement(self) -> None:
        envelope = {
            **self._envelope("completed"),
            "artifacts_available": False,
        }
        self.assertEqual(self._reconcile(envelope), 1)
        self.assertEqual(self._state(), "consumed")

    def test_missing_job_before_grace_period_remains_reserved(self) -> None:
        event = self.store.get_usage_event(self.reservation.id)
        created_at = datetime.fromisoformat(str(event["created_at"]))
        with patch(
            "app.pdf_reconciliation.get_pdf_request",
            side_effect=PdfTranslationError("not found", status_code=404),
        ):
            settled = reconcile_pdf_reservations(
                now=created_at + timedelta(hours=23),
                missing_grace_s=24 * 60 * 60,
            )
        self.assertEqual(settled, 0)
        self.assertEqual(self._state(), "reserved")

    def test_missing_job_after_grace_period_is_consumed(self) -> None:
        event = self.store.get_usage_event(self.reservation.id)
        created_at = datetime.fromisoformat(str(event["created_at"]))
        with patch(
            "app.pdf_reconciliation.get_pdf_request",
            side_effect=PdfTranslationError("not found", status_code=404),
        ):
            settled = reconcile_pdf_reservations(
                now=created_at + timedelta(hours=25),
                missing_grace_s=24 * 60 * 60,
            )
        self.assertEqual(settled, 1)
        self.assertEqual(self._state(), "consumed")
        self.assertEqual(
            self._metadata()["settlement_reason"],
            "missing_service_record_after_grace",
        )

    def test_service_outage_remains_reserved(self) -> None:
        with patch(
            "app.pdf_reconciliation.get_pdf_request",
            side_effect=PdfTranslationError("unreachable", status_code=502),
        ):
            settled = reconcile_pdf_reservations(
                now=datetime.now(timezone.utc) + timedelta(days=30),
                missing_grace_s=0,
            )
        self.assertEqual(settled, 0)
        self.assertEqual(self._state(), "reserved")


class PdfReconciliationLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_loop_runs_a_pass_before_sleeping(self) -> None:
        with (
            patch("app.pdf_reconciliation.reconcile_pdf_reservations") as reconcile,
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
