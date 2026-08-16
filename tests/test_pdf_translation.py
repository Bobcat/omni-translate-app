from __future__ import annotations

import json
import unittest
import uuid
from unittest.mock import patch

import httpx

from fastapi.testclient import TestClient

from app.main import app
from app.pdf_render_options import APP_PDF_RENDER_DEFAULTS
from app.pdf_translation_bridge import PdfTranslationError
from app.pdf_translation_bridge import get_pdf_request
from app.pdf_translation_bridge import rerender_pdf_request
from app.pdf_translation_bridge import submit_pdf
from saas.errors import RESOURCE_NOT_FOUND, SaasError


def _post(
    client: TestClient,
    *,
    content: bytes = b"%PDF-1.4 fake",
    target_language: str = "English",
    operation_id: str | None = None,
    render_options: dict[str, str] | None = None,
):
    return client.post(
        "/api/pdf-translation/requests",
        files={"document_file": ("doc.pdf", content, "application/pdf")},
        data={"target_language": target_language, **dict(render_options or {})},
        headers={"Idempotency-Key": operation_id or str(uuid.uuid4())},
    )


def _not_owned() -> SaasError:
    return SaasError(RESOURCE_NOT_FOUND, "PDF request not found", status_code=404)


class PdfTranslationRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        # No context manager on purpose: lifespan (ASR warmup) must not run.
        self.client = TestClient(app)

    def test_config_exposes_the_account_pdf_plan_for_the_quota_cta(self) -> None:
        response = self.client.get("/api/config")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["pdf_translation"]["account_plan"],
            {"pages_per_period": 50, "max_pages_per_job": 25},
        )

    def test_happy_path_returns_envelope(self) -> None:
        operation_id = str(uuid.uuid4())
        envelope = {"request_id": operation_id, "state": "queued", "queue_position": 1}
        with patch("app.router.submit_pdf_with_quota", return_value=(envelope, None)) as mock_submit:
            response = _post(self.client, operation_id=operation_id)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), envelope)
        self.assertEqual(mock_submit.call_count, 1)
        self.assertEqual(mock_submit.call_args.kwargs["operation_id"], operation_id)
        self.assertEqual(
            mock_submit.call_args.kwargs["render_options"],
            APP_PDF_RENDER_DEFAULTS.model_dump(),
        )

    def test_submit_accepts_explicit_render_options(self) -> None:
        operation_id = str(uuid.uuid4())
        envelope = {"request_id": operation_id, "state": "queued"}
        with patch("app.router.submit_pdf_with_quota", return_value=(envelope, None)) as mock_submit:
            response = _post(
                self.client,
                operation_id=operation_id,
                render_options={
                    "page_layout_mode": "fit",
                    "page_scale": "0.8",
                    "width_fit_mode": "extend_to_margin",
                },
            )

        self.assertEqual(response.status_code, 200)
        options = mock_submit.call_args.kwargs["render_options"]
        self.assertEqual(options["page_layout_mode"], "fit")
        self.assertEqual(options["page_scale"], 0.8)
        self.assertEqual(options["width_fit_mode"], "extend_to_margin")
        self.assertEqual(options["pdf_output_mode"], "vector")

    def test_missing_operation_id_is_rejected(self) -> None:
        response = self.client.post(
            "/api/pdf-translation/requests",
            files={"document_file": ("doc.pdf", b"%PDF-1.4 fake", "application/pdf")},
            data={"target_language": "English"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "INVALID_OPERATION_ID")

    def test_invalid_operation_id_is_rejected(self) -> None:
        with patch("app.router.submit_pdf_with_quota") as mock_submit:
            response = _post(self.client, operation_id="not-a-uuid")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "INVALID_OPERATION_ID")
        mock_submit.assert_not_called()

    def test_empty_upload_rejected(self) -> None:
        response = _post(self.client, content=b"")
        self.assertEqual(response.status_code, 400)
        self.assertIn("empty document upload", response.json()["detail"])

    def test_oversize_upload_rejected_before_full_read(self) -> None:
        # A small configured limit keeps the test light; the upload is larger.
        with patch("app.router.get_int", return_value=10):
            response = _post(self.client, content=b"x" * 100)

        self.assertEqual(response.status_code, 413)
        self.assertIn("document too large", response.json()["detail"])

    def test_bridge_error_maps_to_its_status(self) -> None:
        # E.g. an unsupported target language; validation lives in the bridge.
        with patch(
            "app.router.submit_pdf_with_quota",
            side_effect=PdfTranslationError(
                "unsupported translation language: Klingon", status_code=400
            ),
        ):
            response = _post(self.client, target_language="Klingon")
        self.assertEqual(response.status_code, 400)
        self.assertIn("unsupported translation language", response.json()["detail"])

    def test_status_does_not_reveal_an_unowned_request(self) -> None:
        with (
            patch("app.router.require_pdf_request_owner", side_effect=_not_owned()),
            patch("app.router.get_pdf_request") as mock_get,
        ):
            response = self.client.get("/api/pdf-translation/requests/req-other")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], RESOURCE_NOT_FOUND)
        mock_get.assert_not_called()

    def test_status_restores_durable_preview_metadata(self) -> None:
        operation_id = str(uuid.uuid4())
        event = {
            "metadata": json.dumps(
                {
                    "pdf_source_pages": 9,
                    "pdf_translated_pages": 2,
                    "pdf_preview": True,
                }
            )
        }
        with (
            patch("app.router.require_pdf_request_owner", return_value=event),
            patch(
                "app.router.get_pdf_request",
                return_value={"request_id": operation_id, "state": "running"},
            ),
        ):
            response = self.client.get(f"/api/pdf-translation/requests/{operation_id}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["pdf_preview"],
            {"source_pages": 9, "translated_pages": 2},
        )

    def test_cancel_does_not_touch_an_unowned_request(self) -> None:
        with (
            patch("app.router.require_pdf_request_owner", side_effect=_not_owned()),
            patch("app.router.cancel_pdf_request") as mock_cancel,
        ):
            response = self.client.post("/api/pdf-translation/requests/req-other/cancel")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], RESOURCE_NOT_FOUND)
        mock_cancel.assert_not_called()

    def test_artifact_does_not_fetch_an_unowned_request(self) -> None:
        with (
            patch("app.router.require_pdf_request_owner", side_effect=_not_owned()),
            patch("app.router.get_pdf_artifact") as mock_get,
        ):
            response = self.client.get("/api/pdf-translation/requests/req-other/artifacts/input")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], RESOURCE_NOT_FOUND)
        mock_get.assert_not_called()

    def test_rerender_does_not_touch_an_unowned_request(self) -> None:
        operation_id = str(uuid.uuid4())
        with (
            patch("app.router.require_pdf_request_owner", side_effect=_not_owned()),
            patch("app.router.rerender_pdf_request") as mock_rerender,
        ):
            response = self.client.post(
                "/api/pdf-translation/requests/req-other/rerender",
                json={},
                headers={"Idempotency-Key": operation_id},
            )

        self.assertEqual(response.status_code, 404)
        mock_rerender.assert_not_called()

    def test_rerender_is_owned_and_uses_app_defaults(self) -> None:
        operation_id = str(uuid.uuid4())
        envelope = {"request_id": operation_id, "state": "queued"}
        with (
            patch("app.router.require_pdf_request_owner", return_value=None),
            patch("app.router.record_pdf_rerender_owner") as mock_record,
            patch("app.router.rerender_pdf_request", return_value=envelope) as mock_rerender,
        ):
            response = self.client.post(
                "/api/pdf-translation/requests/source-id/rerender",
                json={},
                headers={"Idempotency-Key": operation_id},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), envelope)
        mock_record.assert_called_once()
        self.assertEqual(mock_record.call_args.args[1], operation_id)
        self.assertEqual(
            mock_rerender.call_args.kwargs["render_options"],
            APP_PDF_RENDER_DEFAULTS.model_dump(),
        )
        self.assertEqual(mock_rerender.call_args.kwargs["operation_id"], operation_id)


class SubmitPdfTests(unittest.TestCase):
    def test_unsupported_language_raises_400_error_without_network(self) -> None:
        # Validation must happen before the multipart submit is built/sent.
        with self.assertRaises(PdfTranslationError) as ctx:
            submit_pdf(
                document_bytes=b"%PDF-1.4 fake",
                filename="doc.pdf",
                content_type="application/pdf",
                target_language="Klingon",
                operation_id=str(uuid.uuid4()),
                render_options=APP_PDF_RENDER_DEFAULTS.model_dump(),
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_operation_id_is_forwarded_as_the_upstream_request_id(self) -> None:
        operation_id = str(uuid.uuid4())
        with patch(
            "app.pdf_translation_bridge._submit_multipart",
            return_value={"request_id": operation_id, "state": "queued"},
        ) as mock_submit:
            submit_pdf(
                document_bytes=b"%PDF-1.4 fake",
                filename="doc.pdf",
                content_type="application/pdf",
                target_language="English",
                operation_id=operation_id,
                render_options=APP_PDF_RENDER_DEFAULTS.model_dump(),
            )
        request_json = json.loads(mock_submit.call_args.args[0])
        self.assertEqual(request_json["request_id"], operation_id)
        self.assertEqual(request_json["page_layout_mode"], "typeset")
        self.assertEqual(request_json["page_scale"], 0.9)
        self.assertEqual(request_json["pdf_output_mode"], "vector")

    def test_rerender_payload_includes_operation_id_and_render_options(self) -> None:
        operation_id = str(uuid.uuid4())
        with patch(
            "app.pdf_translation_bridge._read_json",
            return_value={"request_id": operation_id, "state": "queued"},
        ) as mock_read:
            rerender_pdf_request(
                "source id",
                operation_id=operation_id,
                render_options=APP_PDF_RENDER_DEFAULTS.model_dump(),
            )

        payload = json.loads(mock_read.call_args.kwargs["content"])
        self.assertEqual(payload["request_id"], operation_id)
        self.assertEqual(payload["page_layout_mode"], "typeset")
        self.assertIn("source%20id/rerender", mock_read.call_args.args[1])

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
            with self.assertRaises(PdfTranslationError) as ctx:
                get_pdf_request("missing")
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("request_id not found", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
