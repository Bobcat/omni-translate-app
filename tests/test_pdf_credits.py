from __future__ import annotations

import io
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from pypdf import PdfWriter

from app.credits.pdf_translation import (
    confirm_pdf_credit_translation,
    quote_pdf_credit_translation,
    settle_pdf_credit_envelope,
    submit_pdf_credit_preparation,
)
from app.credits.policy import CreditCostPolicy
from app.credits.quotes import CREDITS_METRIC, CreditQuoteService
from app.pdf_translation_bridge import prepare_pdf
from saas.entitlements import EntitlementSet
from saas.errors import CREDITS_EXHAUSTED, QUOTE_MISMATCH, SaasError
from saas.principals import Principal
from saas.storage import SaasStore
from saas.usage import QuotaService


TENANT = "t"
QUOTA = {
    "source_character_counting_version": "semantic-codepoints-v1",
    "source_character_count": 32940,
    "source_character_raw_count": 34000,
    "source_character_preserved_count": 800,
    "source_character_decoration_count": 260,
    "page_count": 2,
    "authorization_expires_at_utc": (
        datetime.now(timezone.utc) + timedelta(minutes=5)
    ).isoformat(),
}


def make_pdf(pages: int) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=72, height=72)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def policy() -> CreditCostPolicy:
    return CreditCostPolicy.from_config(
        config={
            "version": "credits-v1",
            "quote_ttl_seconds": 900,
            "denomination_eur": "0.001",
            "actions": {
                "pdf_translation": {
                    "minimum_credits": 20,
                    "credits_per_page": 20,
                    "source_character_block_size": 1000,
                    "credits_per_source_character_block": 10,
                }
            },
        },
    )


class PdfCreditFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.store = SaasStore(Path(self.tmp.name) / "saas.db")
        self.quota_service = QuotaService(self.store)
        self.policy = policy()
        self.quote_service = CreditQuoteService(
            store=self.store,
            quota_service=self.quota_service,
            policy=self.policy,
        )
        self.ctx = SimpleNamespace(
            tenant=TENANT,
            store=self.store,
            quota_service=self.quota_service,
            credit_policy=self.policy,
            credit_quote_service=self.quote_service,
        )
        self.principal = Principal(
            tenant=TENANT,
            kind="user",
            id=uuid.uuid4(),
            plan_code="free",
        )
        self.entitlements = EntitlementSet(
            "free",
            {
                "pdf_translation.enabled": True,
                "pdf_translation.max_pages_per_job": 25,
                "pdf_translation.preview_first_pages": False,
                "compute.credits_per_period": 3000,
                "compute.period": "month",
            },
        )
        self.context_patch = patch(
            "app.credits.pdf_translation.get_saas_context",
            return_value=self.ctx,
        )
        self.resolve_patch = patch(
            "app.credits.pdf_translation.resolve_request_context",
            return_value=(self.principal, self.entitlements, None),
        )
        self.owner_patch = patch("app.credits.pdf_translation.record_pdf_credit_owner")
        self.context_patch.start()
        self.resolve_patch.start()
        self.owner_patch.start()

    def tearDown(self) -> None:
        self.owner_patch.stop()
        self.resolve_patch.stop()
        self.context_patch.stop()
        self.store.close()
        self.tmp.cleanup()

    def usage(self) -> tuple[int, int]:
        summary = self.quota_service.get_usage(self.principal, CREDITS_METRIC, "month")
        return summary.reserved, summary.consumed

    def prepare(self, operation_id: str) -> None:
        with patch(
            "app.credits.pdf_translation.prepare_pdf",
            return_value={"request_id": operation_id, "state": "queued"},
        ):
            envelope = submit_pdf_credit_preparation(
                None,
                document_bytes=make_pdf(2),
                filename="doc.pdf",
                content_type="application/pdf",
                operation_id=operation_id,
            )
        self.assertEqual(envelope["pdf_scope"]["translated_pages"], 2)

    def create_quote(self, operation_id: str, target: str = "Dutch") -> dict:
        with patch(
            "app.credits.pdf_translation.get_pdf_request",
            return_value={
                "request_id": operation_id,
                "state": "awaiting_quota",
                "quota": dict(QUOTA),
            },
        ):
            return quote_pdf_credit_translation(
                None,
                request_id=operation_id,
                target_language=target,
            )["quote"]

    def confirm(self, operation_id: str, quote: dict, target: str = "Dutch") -> dict:
        waiting = {
            "request_id": operation_id,
            "state": "awaiting_quota",
            "quota": dict(QUOTA),
        }
        queued = {
            "request_id": operation_id,
            "state": "queued",
            "quota": dict(QUOTA),
        }
        with (
            patch("app.credits.pdf_translation.get_pdf_request", return_value=waiting),
            patch("app.credits.pdf_translation.authorize_pdf_request", return_value=queued),
        ):
            return confirm_pdf_credit_translation(
                None,
                request_id=operation_id,
                quote_id=quote["id"],
                target_language=target,
            )

    def test_prepare_quote_confirm_and_success_use_one_fixed_price(self) -> None:
        operation_id = str(uuid.uuid4())
        self.prepare(operation_id)
        self.assertEqual(self.usage(), (0, 0))

        quote = self.create_quote(operation_id)
        self.assertEqual(quote["credits"], 390)
        self.assertEqual(quote["pages"], 2)
        self.assertEqual(quote["source_characters"], 32940)
        self.assertEqual(quote["remaining_after_confirmation"], 2610)
        self.assertEqual(self.usage(), (0, 0))

        envelope = self.confirm(operation_id, quote)
        self.assertEqual(envelope["credit_usage"]["credits"], 390)
        self.assertEqual(self.usage(), (390, 0))

        completed = {
            "request_id": operation_id,
            "state": "completed",
            "quota": {**QUOTA, "compute_started_at_utc": datetime.now(timezone.utc).isoformat()},
            "response": {
                "metadata": {"source_character_count": 99999, "page_count": 2},
                "metrics": {"translate_pdf_total_wall_ms": 1234},
            },
        }
        self.assertEqual(settle_pdf_credit_envelope(self.principal, completed), "consumed")
        self.assertEqual(self.usage(), (0, 390))

    def test_cancel_before_compute_returns_the_complete_reservation(self) -> None:
        operation_id = str(uuid.uuid4())
        self.prepare(operation_id)
        quote = self.create_quote(operation_id)
        self.confirm(operation_id, quote)

        outcome = settle_pdf_credit_envelope(
            self.principal,
            {"request_id": operation_id, "state": "cancelled", "quota": dict(QUOTA)},
        )

        self.assertEqual(outcome, "released")
        self.assertEqual(self.usage(), (0, 0))

    def test_cancel_after_compute_consumes_the_complete_quote(self) -> None:
        operation_id = str(uuid.uuid4())
        self.prepare(operation_id)
        quote = self.create_quote(operation_id)
        self.confirm(operation_id, quote)

        outcome = settle_pdf_credit_envelope(
            self.principal,
            {
                "request_id": operation_id,
                "state": "cancelled",
                "quota": {**QUOTA, "compute_started_at_utc": datetime.now(timezone.utc).isoformat()},
            },
        )

        self.assertEqual(outcome, "consumed")
        self.assertEqual(self.usage(), (0, 390))

    def test_target_change_requires_its_own_quote(self) -> None:
        operation_id = str(uuid.uuid4())
        self.prepare(operation_id)
        quote = self.create_quote(operation_id, target="Dutch")

        with self.assertRaises(SaasError) as caught:
            self.confirm(operation_id, quote, target="German")

        self.assertEqual(caught.exception.code, QUOTE_MISMATCH)
        self.assertEqual(self.usage(), (0, 0))

    def test_insufficient_credits_stops_before_authorization(self) -> None:
        operation_id = str(uuid.uuid4())
        self.prepare(operation_id)
        quote = self.create_quote(operation_id)
        limited = EntitlementSet(
            "free",
            {**self.entitlements.snapshot(), "compute.credits_per_period": 100},
        )
        with (
            patch(
                "app.credits.pdf_translation.resolve_request_context",
                return_value=(self.principal, limited, None),
            ),
            patch("app.credits.pdf_translation.get_pdf_request", return_value={
                "request_id": operation_id,
                "state": "awaiting_quota",
                "quota": dict(QUOTA),
            }),
            patch("app.credits.pdf_translation.authorize_pdf_request") as authorize,
            self.assertRaises(SaasError) as caught,
        ):
            confirm_pdf_credit_translation(
                None,
                request_id=operation_id,
                quote_id=quote["id"],
                target_language="Dutch",
            )

        self.assertEqual(caught.exception.code, CREDITS_EXHAUSTED)
        authorize.assert_not_called()
        self.assertEqual(self.usage(), (0, 0))


class PreparePdfBridgeTests(unittest.TestCase):
    def test_preparation_omits_target_and_requests_authorization_pause(self) -> None:
        operation_id = str(uuid.uuid4())
        with patch(
            "app.pdf_translation_bridge._submit_multipart",
            return_value={"request_id": operation_id, "state": "queued"},
        ) as submit:
            prepare_pdf(
                document_bytes=make_pdf(1),
                filename="doc.pdf",
                content_type="application/pdf",
                operation_id=operation_id,
                render_options={},
            )

        request_json = submit.call_args.args[0]
        self.assertIn('"quota_authorization_required": true', request_json)
        self.assertNotIn("target_lang_code", request_json)


if __name__ == "__main__":
    unittest.main()
