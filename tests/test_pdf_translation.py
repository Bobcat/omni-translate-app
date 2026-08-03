from __future__ import annotations

import io
import json
import unittest
import uuid
from unittest.mock import patch
from urllib.error import HTTPError

from fastapi.testclient import TestClient

from app.main import app
from app.pdf_translation_bridge import PdfTranslationError
from app.pdf_translation_bridge import get_pdf_request
from app.pdf_translation_bridge import submit_pdf
from saas.errors import RESOURCE_NOT_FOUND, SaasError


def _post(
    client: TestClient,
    *,
    content: bytes = b"%PDF-1.4 fake",
    target_language: str = "English",
    operation_id: str | None = None,
):
    return client.post(
        "/api/pdf-translation/requests",
        files={"document_file": ("doc.pdf", content, "application/pdf")},
        data={"target_language": target_language},
        headers={"Idempotency-Key": operation_id or str(uuid.uuid4())},
    )


def _not_owned() -> SaasError:
    return SaasError(RESOURCE_NOT_FOUND, "PDF request not found", status_code=404)


class PdfTranslationRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        # No context manager on purpose: lifespan (ASR warmup) must not run.
        self.client = TestClient(app)

    def test_happy_path_returns_envelope(self) -> None:
        operation_id = str(uuid.uuid4())
        envelope = {"request_id": operation_id, "state": "queued", "queue_position": 1}
        with patch("app.router.submit_pdf_with_quota", return_value=(envelope, None)) as mock_submit:
            response = _post(self.client, operation_id=operation_id)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), envelope)
        self.assertEqual(mock_submit.call_count, 1)
        self.assertEqual(mock_submit.call_args.kwargs["operation_id"], operation_id)

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
            )
        request_json = json.loads(mock_submit.call_args.args[0])
        self.assertEqual(request_json["request_id"], operation_id)

    def test_upstream_status_code_is_preserved(self) -> None:
        error = HTTPError(
            "http://service/v1/requests/missing",
            404,
            "Not Found",
            {},
            io.BytesIO(b'{"code":"REQUEST_NOT_FOUND","message":"request_id not found"}'),
        )
        with patch("app.pdf_translation_bridge.urlopen", side_effect=error):
            with self.assertRaises(PdfTranslationError) as ctx:
                get_pdf_request("missing")
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("request_id not found", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
