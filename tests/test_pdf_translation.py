from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.pdf_translation_bridge import PdfTranslationError
from app.pdf_translation_bridge import submit_pdf


def _post(client: TestClient, *, content: bytes = b"%PDF-1.4 fake", target_language: str = "English"):
    return client.post(
        "/api/pdf-translation/requests",
        files={"document_file": ("doc.pdf", content, "application/pdf")},
        data={"target_language": target_language},
    )


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
