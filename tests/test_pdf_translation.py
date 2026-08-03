from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.pdf_translation_bridge import PdfTranslationError
from app.pdf_translation_bridge import submit_pdf
from saas.errors import RESOURCE_NOT_FOUND, SaasError


def _post(client: TestClient, *, content: bytes = b"%PDF-1.4 fake", target_language: str = "English"):
    return client.post(
        "/api/pdf-translation/requests",
        files={"document_file": ("doc.pdf", content, "application/pdf")},
        data={"target_language": target_language},
    )


def _not_owned() -> SaasError:
    return SaasError(RESOURCE_NOT_FOUND, "PDF request not found", status_code=404)


class PdfTranslationRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        # No context manager on purpose: lifespan (ASR warmup) must not run.
        self.client = TestClient(app)

    def test_happy_path_returns_envelope(self) -> None:
        envelope = {"request_id": "req-1", "state": "queued", "queue_position": 1}
        with patch("app.router.submit_pdf_with_quota", return_value=(envelope, None)) as mock_submit:
            response = _post(self.client)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), envelope)
        self.assertEqual(mock_submit.call_count, 1)

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
            )
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
