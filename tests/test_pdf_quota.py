"""PDF page quota (phase 5d): page counting, the reserve-around-submit flow
and reservation settlement over the job lifecycle. Runs against a real
sqlite store in a tmp dir; the upstream bridge and request-context
resolution are patched out.
"""
from __future__ import annotations

import io
import json
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
    require_pdf_request_owner,
    submit_pdf_with_quota,
)
from app.pdf_ownership import PDF_RERENDER_RESOURCE
from app.pdf_render_options import APP_PDF_RENDER_DEFAULTS
from app.pdf_translation_bridge import PdfTranslationError
from app.saas_setup import SaasContext
from saas.entitlements import EntitlementService
from saas.errors import (
    ENTITLEMENT_DISABLED,
    INVALID_OPERATION_ID,
    INVALID_UPLOAD,
    PAGE_LIMIT_PER_JOB_EXCEEDED,
    PERIOD_QUOTA_EXCEEDED,
    RESOURCE_NOT_FOUND,
    USAGE_IDEMPOTENCY_CONFLICT,
    SaasError,
)
from saas.principals import Principal
from saas.storage import SaasStore
from saas.usage import QuotaService

TENANT = "t"
PLANS = {
    "anonymous": {
        "pdf_translation.enabled": True,
        "pdf_translation.pages_per_period": 6,
        "pdf_translation.period": "month",
        "pdf_translation.max_pages_per_job": 2,
        "pdf_translation.preview_first_pages": True,
    },
    "disabled": {},
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
        return self._usage_for(self.principal)

    def _usage_for(self, principal: Principal) -> tuple[int, int]:
        summary = self.ctx.quota_service.get_usage(principal, PAGES_METRIC, "month")
        return summary.reserved, summary.consumed

    def _submit(self, pages: int = 5, *, operation_id: str | None = None) -> dict:
        operation_id = operation_id or str(uuid.uuid4())
        envelope = {"request_id": operation_id, "state": "queued"}
        with patch("app.pdf_quota.submit_pdf", return_value=envelope) as mock_submit:
            result, token = submit_pdf_with_quota(
                None,
                document_bytes=make_pdf(pages),
                filename="doc.pdf",
                content_type="application/pdf",
                target_language="English",
                operation_id=operation_id,
                render_options=APP_PDF_RENDER_DEFAULTS.model_dump(),
            )
        self.assertIsNone(token)
        self.assertEqual(mock_submit.call_args.kwargs["operation_id"], operation_id)
        self.last_submit_kwargs = mock_submit.call_args.kwargs
        return result

    def test_submit_reserves_pages_and_links_the_job(self) -> None:
        envelope = self._submit(5)
        self.assertEqual(self._usage(), (5, 0))
        event = self.store.get_usage_event_by_job_id(TENANT, envelope["request_id"])
        self.assertIsNotNone(event)
        self.assertEqual(event["state"], "reserved")
        self.assertEqual(event["idempotency_key"], f"pdf-submit:{envelope['request_id']}")

    def test_same_operation_does_not_reserve_or_submit_under_a_second_id(self) -> None:
        operation_id = str(uuid.uuid4())
        first = self._submit(5, operation_id=operation_id)
        second = self._submit(5, operation_id=operation_id)
        self.assertEqual(first["request_id"], second["request_id"])
        self.assertEqual(self._usage(), (5, 0))

    def test_same_operation_with_different_page_count_conflicts(self) -> None:
        operation_id = str(uuid.uuid4())
        self._submit(5, operation_id=operation_id)
        with self.assertRaises(SaasError) as ctx:
            self._submit(6, operation_id=operation_id)
        self.assertEqual(ctx.exception.code, USAGE_IDEMPOTENCY_CONFLICT)
        self.assertEqual(ctx.exception.status_code, 409)

    def test_invalid_operation_id_is_rejected_before_reserving(self) -> None:
        with self.assertRaises(SaasError) as ctx:
            submit_pdf_with_quota(
                None,
                document_bytes=make_pdf(1),
                filename="doc.pdf",
                content_type="application/pdf",
                target_language="English",
                operation_id="not-a-uuid",
                render_options=APP_PDF_RENDER_DEFAULTS.model_dump(),
            )
        self.assertEqual(ctx.exception.code, INVALID_OPERATION_ID)
        self.assertEqual(self._usage(), (0, 0))

    def test_per_job_page_cap_rejects_before_reserving(self) -> None:
        with self.assertRaises(SaasError) as ctx:
            self._submit(11)
        self.assertEqual(ctx.exception.code, PAGE_LIMIT_PER_JOB_EXCEEDED)
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertEqual(self._usage(), (0, 0))

    def test_anonymous_long_pdf_submits_and_reserves_only_the_first_two_pages(self) -> None:
        anonymous = _principal("anonymous")
        with patch(
            "app.pdf_quota.resolve_request_context",
            return_value=(anonymous, self.entitlements.resolve(anonymous), None),
        ):
            envelope = self._submit(5)

        self.assertEqual(count_pdf_pages(self.last_submit_kwargs["document_bytes"]), 2)
        self.assertEqual(self._usage_for(anonymous), (2, 0))
        self.assertEqual(
            envelope["pdf_preview"],
            {"source_pages": 5, "translated_pages": 2},
        )
        event = self.store.get_usage_event_by_job_id(TENANT, envelope["request_id"])
        metadata = json.loads(event["metadata"])
        self.assertEqual(metadata["pdf_source_pages"], 5)
        self.assertEqual(metadata["pdf_translated_pages"], 2)
        self.assertTrue(metadata["pdf_preview"])

    def test_anonymous_short_pdf_is_not_marked_as_a_partial_preview(self) -> None:
        anonymous = _principal("anonymous")
        with patch(
            "app.pdf_quota.resolve_request_context",
            return_value=(anonymous, self.entitlements.resolve(anonymous), None),
        ):
            envelope = self._submit(1)

        self.assertEqual(count_pdf_pages(self.last_submit_kwargs["document_bytes"]), 1)
        self.assertEqual(self._usage_for(anonymous), (1, 0))
        self.assertNotIn("pdf_preview", envelope)

    def test_anonymous_period_limit_counts_translated_preview_pages(self) -> None:
        anonymous = _principal("anonymous")
        with patch(
            "app.pdf_quota.resolve_request_context",
            return_value=(anonymous, self.entitlements.resolve(anonymous), None),
        ):
            self._submit(10)
            self._submit(10)
            self._submit(10)
            with self.assertRaises(SaasError) as ctx:
                self._submit(10)

        self.assertEqual(ctx.exception.code, PERIOD_QUOTA_EXCEEDED)
        self.assertEqual(self._usage_for(anonymous), (6, 0))

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

    def test_uncertain_upstream_failure_keeps_the_reservation(self) -> None:
        operation_id = str(uuid.uuid4())
        with patch("app.pdf_quota.submit_pdf", side_effect=PdfTranslationError("boom")):
            with self.assertRaises(PdfTranslationError):
                submit_pdf_with_quota(
                    None,
                    document_bytes=make_pdf(5),
                    filename="doc.pdf",
                    content_type="application/pdf",
                    target_language="English",
                    operation_id=operation_id,
                    render_options=APP_PDF_RENDER_DEFAULTS.model_dump(),
                )
        self.assertEqual(self._usage(), (5, 0))
        event = self.store.get_usage_event_by_job_id(TENANT, operation_id)
        self.assertIsNotNone(event)
        self.assertEqual(event["state"], "reserved")

    def test_unexpected_upstream_request_id_keeps_the_reservation(self) -> None:
        operation_id = str(uuid.uuid4())
        with patch(
            "app.pdf_quota.submit_pdf",
            return_value={"request_id": str(uuid.uuid4()), "state": "queued"},
        ):
            with self.assertRaises(PdfTranslationError):
                submit_pdf_with_quota(
                    None,
                    document_bytes=make_pdf(5),
                    filename="doc.pdf",
                    content_type="application/pdf",
                    target_language="English",
                    operation_id=operation_id,
                    render_options=APP_PDF_RENDER_DEFAULTS.model_dump(),
                )
        self.assertEqual(self._usage(), (5, 0))
        self.assertIsNotNone(self.store.get_usage_event_by_job_id(TENANT, operation_id))

    def test_disabled_entitlement_rejects(self) -> None:
        disabled = _principal("disabled")
        with patch(
            "app.pdf_quota.resolve_request_context",
            return_value=(disabled, self.entitlements.resolve(disabled), None),
        ):
            with self.assertRaises(SaasError) as ctx:
                self._submit(5)
        self.assertEqual(ctx.exception.code, ENTITLEMENT_DISABLED)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_completed_job_consumes_the_reservation(self) -> None:
        envelope = self._submit(5)
        finalize_pdf_reservation({**envelope, "state": "completed"})
        self.assertEqual(self._usage(), (0, 5))

    def test_confirmed_technical_failure_releases_the_reservation(self) -> None:
        envelope = self._submit(5)
        finalize_pdf_reservation(
            {
                **envelope,
                "state": "failed",
                "error": {"code": "REQUEST_FAILED", "message": "pipeline crashed"},
            }
        )
        self.assertEqual(self._usage(), (0, 0))

    def test_unclassified_failure_consumes_the_reservation(self) -> None:
        envelope = self._submit(5)
        finalize_pdf_reservation({**envelope, "state": "failed"})
        self.assertEqual(self._usage(), (0, 5))

    def test_caller_actionable_failure_consumes_the_reservation(self) -> None:
        envelope = self._submit(5)
        finalize_pdf_reservation(
            {
                **envelope,
                "state": "failed",
                "error": {"code": "SOURCE_CHARACTER_LIMIT_EXCEEDED"},
            }
        )
        self.assertEqual(self._usage(), (0, 5))

    def test_cancelled_job_consumes_the_reservation(self) -> None:
        envelope = self._submit(5)
        finalize_pdf_reservation({**envelope, "state": "cancelled"})
        self.assertEqual(self._usage(), (0, 5))

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

    def test_pdf_request_owner_is_accepted(self) -> None:
        envelope = self._submit(5)
        require_pdf_request_owner(None, envelope["request_id"])

    def test_quota_free_pdf_rerender_owner_is_accepted(self) -> None:
        operation_id = str(uuid.uuid4())
        self.assertTrue(
            self.store.claim_resource_owner(
                TENANT,
                PDF_RERENDER_RESOURCE,
                operation_id,
                self.principal.kind,
                self.principal.id,
                "payload-hash",
            )
        )

        self.assertIsNone(require_pdf_request_owner(None, operation_id))

    def test_same_job_id_in_another_metric_cannot_shadow_pdf_event(self) -> None:
        operation_id = str(uuid.uuid4())
        character_reservation = self.ctx.quota_service.reserve(
            self.principal,
            metric="translation.source_characters",
            quantity=12,
            limit=100,
            period_kind="month",
            job_id=operation_id,
            idempotency_key=f"image-characters:{operation_id}",
        )
        envelope = self._submit(5, operation_id=operation_id)

        require_pdf_request_owner(None, operation_id)
        finalize_pdf_reservation({**envelope, "state": "completed"})

        self.assertEqual(self._usage(), (0, 5))
        self.assertEqual(
            str(self.store.get_usage_event(character_reservation.id)["state"]),
            "reserved",
        )

    def test_other_principal_cannot_access_pdf_request(self) -> None:
        envelope = self._submit(5)
        other = _principal()
        with patch(
            "app.pdf_quota.resolve_request_context",
            return_value=(other, self.entitlements.resolve(other), None),
        ):
            with self.assertRaises(SaasError) as ctx:
                require_pdf_request_owner(None, envelope["request_id"])
        self.assertEqual(ctx.exception.code, RESOURCE_NOT_FOUND)
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
