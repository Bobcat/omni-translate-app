"""PDF page quota (phase 5d): page counting, the reserve-around-submit flow
and reservation settlement over the job lifecycle. Runs against a real
sqlite store in a tmp dir; the upstream bridge and request-context
resolution are patched out.
"""
from __future__ import annotations

import io
import unittest
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from pypdf import PdfWriter

from app.pdf_quota import (
    PAGES_METRIC,
    count_pdf_pages,
    finalize_pdf_reservation,
    submit_pdf_with_quota,
)
from app.pdf_translation_bridge import PdfTranslationError
from app.saas_setup import SaasContext
from saas.entitlements import EntitlementService
from saas.errors import (
    ENTITLEMENT_DISABLED,
    INVALID_UPLOAD,
    PAGE_LIMIT_PER_JOB_EXCEEDED,
    PERIOD_QUOTA_EXCEEDED,
    SaasError,
)
from saas.principals import Principal
from saas.storage import SaasStore
from saas.usage import QuotaService

TENANT = "t"
PLANS = {
    "anonymous": {"pdf_translation.enabled": False},
    "free": {
        "pdf_translation.enabled": True,
        "pdf_translation.pages_per_period": 50,
        "pdf_translation.period": "month",
        "pdf_translation.max_pages_per_job": 10,
    },
}


def make_pdf(pages: int) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=72, height=72)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def _principal(plan: str = "free") -> Principal:
    kind = "user" if plan != "anonymous" else "anonymous"
    return Principal(tenant=TENANT, kind=kind, id=uuid.uuid4(), plan_code=plan)


class CountPdfPagesTests(unittest.TestCase):
    def test_counts_pages(self) -> None:
        self.assertEqual(count_pdf_pages(make_pdf(3)), 3)

    def test_rejects_unreadable_pdf(self) -> None:
        with self.assertRaises(SaasError) as ctx:
            count_pdf_pages(b"%PDF-1.4 fake")
        self.assertEqual(ctx.exception.code, INVALID_UPLOAD)
        self.assertEqual(ctx.exception.status_code, 400)


class PdfQuotaFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.store = SaasStore(Path(self._tmp.name) / "saas.db")
        self.entitlements = EntitlementService(PLANS)
        self.ctx = SaasContext(
            store=self.store,
            entitlement_service=self.entitlements,
            quota_service=QuotaService(self.store),
            signing_secret="test",
            tenant=TENANT,
            token_verifier=None,
            user_plan="free",
        )
        self.principal = _principal()
        self._context_patch = patch("app.pdf_quota.get_saas_context", return_value=self.ctx)
        self._resolve_patch = patch(
            "app.pdf_quota.resolve_request_context",
            return_value=(
                self.principal,
                self.entitlements.resolve(self.principal),
                None,
            ),
        )
        self._context_patch.start()
        self._resolve_patch.start()

    def tearDown(self) -> None:
        self._resolve_patch.stop()
        self._context_patch.stop()
        self.store.close()
        self._tmp.cleanup()

    def _usage(self) -> tuple[int, int]:
        summary = self.ctx.quota_service.get_usage(self.principal, PAGES_METRIC, "month")
        return summary.reserved, summary.consumed

    def _submit(self, pages: int = 5) -> dict:
        envelope = {"request_id": f"req-{uuid.uuid4().hex[:8]}", "state": "queued"}
        with patch("app.pdf_quota.submit_pdf", return_value=envelope):
            result, token = submit_pdf_with_quota(
                None,
                document_bytes=make_pdf(pages),
                filename="doc.pdf",
                content_type="application/pdf",
                target_language="English",
            )
        self.assertIsNone(token)
        return result

    def test_submit_reserves_pages_and_links_the_job(self) -> None:
        envelope = self._submit(5)
        self.assertEqual(self._usage(), (5, 0))
        event = self.store.get_usage_event_by_job_id(TENANT, envelope["request_id"])
        self.assertIsNotNone(event)
        self.assertEqual(event["state"], "reserved")

    def test_per_job_page_cap_rejects_before_reserving(self) -> None:
        with self.assertRaises(SaasError) as ctx:
            self._submit(11)
        self.assertEqual(ctx.exception.code, PAGE_LIMIT_PER_JOB_EXCEEDED)
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertEqual(self._usage(), (0, 0))

    def test_period_quota_exceeded(self) -> None:
        reservation = self.ctx.quota_service.reserve(
            self.principal,
            metric=PAGES_METRIC,
            quantity=45,
            limit=50,
            period_kind="month",
            idempotency_key="prior",
        )
        self.ctx.quota_service.consume(reservation.id)
        with self.assertRaises(SaasError) as ctx:
            self._submit(10)  # 45 consumed + 10 requested > 50
        self.assertEqual(ctx.exception.code, PERIOD_QUOTA_EXCEEDED)
        self.assertEqual(ctx.exception.status_code, 429)

    def test_upstream_failure_releases_the_reservation(self) -> None:
        with patch("app.pdf_quota.submit_pdf", side_effect=PdfTranslationError("boom")):
            with self.assertRaises(PdfTranslationError):
                submit_pdf_with_quota(
                    None,
                    document_bytes=make_pdf(5),
                    filename="doc.pdf",
                    content_type="application/pdf",
                    target_language="English",
                )
        self.assertEqual(self._usage(), (0, 0))

    def test_disabled_entitlement_rejects(self) -> None:
        anonymous = _principal("anonymous")
        with patch(
            "app.pdf_quota.resolve_request_context",
            return_value=(anonymous, self.entitlements.resolve(anonymous), None),
        ):
            with self.assertRaises(SaasError) as ctx:
                self._submit(5)
        self.assertEqual(ctx.exception.code, ENTITLEMENT_DISABLED)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_completed_job_consumes_the_reservation(self) -> None:
        envelope = self._submit(5)
        finalize_pdf_reservation({**envelope, "state": "completed"})
        self.assertEqual(self._usage(), (0, 5))

    def test_failed_job_releases_the_reservation(self) -> None:
        envelope = self._submit(5)
        finalize_pdf_reservation({**envelope, "state": "failed"})
        self.assertEqual(self._usage(), (0, 0))

    def test_cancelled_job_releases_the_reservation(self) -> None:
        envelope = self._submit(5)
        finalize_pdf_reservation({**envelope, "state": "cancelled"})
        self.assertEqual(self._usage(), (0, 0))

    def test_non_terminal_state_keeps_the_hold(self) -> None:
        envelope = self._submit(5)
        finalize_pdf_reservation({**envelope, "state": "running"})
        self.assertEqual(self._usage(), (5, 0))

    def test_finalize_is_idempotent(self) -> None:
        envelope = self._submit(5)
        finalize_pdf_reservation({**envelope, "state": "completed"})
        finalize_pdf_reservation({**envelope, "state": "completed"})
        finalize_pdf_reservation({**envelope, "state": "failed"})
        self.assertEqual(self._usage(), (0, 5))

    def test_unknown_job_is_a_no_op(self) -> None:
        finalize_pdf_reservation({"request_id": "req-other", "state": "completed"})
        self.assertEqual(self._usage(), (0, 0))


if __name__ == "__main__":
    unittest.main()
