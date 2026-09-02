from __future__ import annotations

import io
import unittest

from pypdf import PdfReader, PdfWriter

from app.pdf_submission import prepare_pdf_submission
from saas.errors import INVALID_UPLOAD, PAGE_LIMIT_PER_JOB_EXCEEDED, SaasError


def make_pdf(pages: int) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=72, height=72)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


class PdfSubmissionTests(unittest.TestCase):
    def test_document_within_limit_is_unchanged(self) -> None:
        document = make_pdf(2)

        submitted, source_pages, translated_pages = prepare_pdf_submission(
            document,
            max_pages=2,
            preview_first_pages=True,
        )

        self.assertEqual(submitted, document)
        self.assertEqual((source_pages, translated_pages), (2, 2))

    def test_preview_plan_submits_only_its_page_scope(self) -> None:
        submitted, source_pages, translated_pages = prepare_pdf_submission(
            make_pdf(5),
            max_pages=2,
            preview_first_pages=True,
        )

        self.assertEqual((source_pages, translated_pages), (5, 2))
        self.assertEqual(len(PdfReader(io.BytesIO(submitted)).pages), 2)

    def test_non_preview_plan_rejects_a_document_over_its_limit(self) -> None:
        with self.assertRaises(SaasError) as caught:
            prepare_pdf_submission(
                make_pdf(3),
                max_pages=2,
                preview_first_pages=False,
            )

        self.assertEqual(caught.exception.code, PAGE_LIMIT_PER_JOB_EXCEEDED)
        self.assertEqual(caught.exception.details["pages"], 3)

    def test_unreadable_pdf_is_rejected(self) -> None:
        with self.assertRaises(SaasError) as caught:
            prepare_pdf_submission(
                b"not a PDF",
                max_pages=2,
                preview_first_pages=True,
            )

        self.assertEqual(caught.exception.code, INVALID_UPLOAD)


if __name__ == "__main__":
    unittest.main()
