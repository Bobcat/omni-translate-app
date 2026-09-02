from __future__ import annotations

import unittest
import uuid
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from app.main import app
from app.pdf_translation_bridge import PdfTranslationError, get_pdf_request
from saas.errors import RESOURCE_NOT_FOUND, SaasError


def _post(
    client: TestClient,
    *,
    content: bytes = b"%PDF-1.4 fake",
    operation_id: str | None = None,
):
    return client.post(
        "/api/pdf-translation/requests",
        files={"document_file": ("doc.pdf", content, "application/pdf")},
        headers={"Idempotency-Key": operation_id or str(uuid.uuid4())},
    )


def _not_owned() -> SaasError:
    return SaasError(RESOURCE_NOT_FOUND, "PDF request not found", status_code=404)


class PdfTranslationRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_config_exposes_credit_plans_without_a_pdf_flow_switch(self) -> None:
        response = self.client.get("/api/config")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertNotIn("pdf_translation", payload)
        self.assertEqual(
            payload["credits"],
            {
                "plans": [
                    {
                        "code": "anonymous",
                        "credits_per_period": 300,
                        "period": "month",
                        "account_required": False,
                        "price_minor_units": 0,
                        "currency": "EUR",
                        "billing_period": "month",
                        "pdf_pages_per_job": 2,
                        "pdf_preview": True,
                    },
                    {
                        "code": "free",
                        "credits_per_period": 3000,
                        "period": "month",
                        "account_required": True,
                        "price_minor_units": 0,
                        "currency": "EUR",
                        "billing_period": "month",
                        "pdf_pages_per_job": 25,
                        "pdf_preview": False,
                    },
                ],
            },
        )

    def test_submit_always_starts_credit_preparation_without_a_target(self) -> None:
        operation_id = str(uuid.uuid4())
        envelope = {"request_id": operation_id, "state": "queued"}
        with patch(
            "app.router.submit_pdf_credit_preparation",
            return_value=envelope,
        ) as prepare:
            response = _post(self.client, operation_id=operation_id)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), envelope)
        self.assertEqual(prepare.call_args.kwargs["operation_id"], operation_id)
        self.assertNotIn("target_language", prepare.call_args.kwargs)

    def test_quote_and_confirm_forward_the_explicit_target(self) -> None:
        request_id = str(uuid.uuid4())
        with (
            patch(
                "app.router.quote_pdf_credit_translation",
                return_value={"request_id": request_id, "quote": {"credits": 390}},
            ) as create_quote,
            patch(
                "app.router.confirm_pdf_credit_translation",
                return_value={"request_id": request_id, "state": "queued"},
            ) as confirm,
        ):
            quote_response = self.client.post(
                f"/api/pdf-translation/requests/{request_id}/quote",
                json={"target_language": "Dutch"},
            )
            confirm_response = self.client.post(
                f"/api/pdf-translation/requests/{request_id}/confirm",
                json={"target_language": "Dutch", "quote_id": str(uuid.uuid4())},
            )

        self.assertEqual(quote_response.status_code, 200)
        self.assertEqual(confirm_response.status_code, 200)
        self.assertEqual(create_quote.call_args.kwargs["target_language"], "Dutch")
        self.assertEqual(confirm.call_args.kwargs["target_language"], "Dutch")

    def test_missing_operation_id_is_rejected(self) -> None:
        response = self.client.post(
            "/api/pdf-translation/requests",
            files={"document_file": ("doc.pdf", b"%PDF-1.4 fake", "application/pdf")},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "INVALID_OPERATION_ID")

    def test_invalid_operation_id_is_rejected(self) -> None:
        with patch("app.router.submit_pdf_credit_preparation") as prepare:
            response = _post(self.client, operation_id="not-a-uuid")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "INVALID_OPERATION_ID")
        prepare.assert_not_called()

    def test_empty_upload_rejected(self) -> None:
        response = _post(self.client, content=b"")
        self.assertEqual(response.status_code, 400)
        self.assertIn("empty document upload", response.json()["detail"])

    def test_oversize_upload_rejected_before_full_read(self) -> None:
        with patch("app.router.get_int", return_value=10):
            response = _post(self.client, content=b"x" * 100)

        self.assertEqual(response.status_code, 413)
        self.assertIn("document too large", response.json()["detail"])

    def test_bridge_error_maps_to_its_status(self) -> None:
        with patch(
            "app.router.submit_pdf_credit_preparation",
            side_effect=PdfTranslationError("invalid PDF", status_code=400),
        ):
            response = _post(self.client)
        self.assertEqual(response.status_code, 400)
        self.assertIn("invalid PDF", response.json()["detail"])

    def test_status_does_not_reveal_an_unowned_request(self) -> None:
        with (
            patch("app.router.resolve_request_context", return_value=(object(), None, None)),
            patch("app.router.require_pdf_credit_operation", side_effect=_not_owned()),
            patch("app.router.get_pdf_request") as get_request,
        ):
            response = self.client.get("/api/pdf-translation/requests/req-other")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], RESOURCE_NOT_FOUND)
        get_request.assert_not_called()

    def test_status_returns_the_credit_context(self) -> None:
        operation = {"operation_id": "req-owned"}
        body = {"request_id": "req-owned", "state": "running", "pdf_scope": {}}
        with (
            patch("app.router.resolve_request_context", return_value=(object(), None, None)),
            patch("app.router.require_pdf_credit_operation", return_value=operation),
            patch(
                "app.router.get_pdf_request",
                return_value={"request_id": "req-owned", "state": "running"},
            ),
            patch("app.router.settle_pdf_credit_envelope"),
            patch("app.router.attach_pdf_credit_context", return_value=body),
        ):
            response = self.client.get("/api/pdf-translation/requests/req-owned")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), body)

    def test_cancel_does_not_touch_an_unowned_request(self) -> None:
        with (
            patch("app.router.resolve_request_context", return_value=(object(), None, None)),
            patch("app.router.require_pdf_credit_operation", side_effect=_not_owned()),
            patch("app.router.cancel_pdf_request") as cancel,
        ):
            response = self.client.post("/api/pdf-translation/requests/req-other/cancel")

        self.assertEqual(response.status_code, 404)
        cancel.assert_not_called()

    def test_artifact_does_not_fetch_an_unowned_request(self) -> None:
        with (
            patch("app.router.resolve_request_context", return_value=(object(), None, None)),
            patch("app.router.require_pdf_credit_operation", side_effect=_not_owned()),
            patch("app.router.get_pdf_artifact") as get_artifact,
        ):
            response = self.client.get(
                "/api/pdf-translation/requests/req-other/artifacts/input"
            )

        self.assertEqual(response.status_code, 404)
        get_artifact.assert_not_called()


class PdfTranslationBridgeTests(unittest.TestCase):
    def test_upstream_status_code_is_preserved(self) -> None:
        def handle(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                404,
                json={"code": "REQUEST_NOT_FOUND", "message": "request_id not found"},
            )

        with httpx.Client(transport=httpx.MockTransport(handle)) as client, patch(
            "app.pdf_translation_bridge.get_upstream_http_client",
            return_value=client,
        ):
            with self.assertRaises(PdfTranslationError) as caught:
                get_pdf_request("missing")
        self.assertEqual(caught.exception.status_code, 404)
        self.assertIn("request_id not found", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
