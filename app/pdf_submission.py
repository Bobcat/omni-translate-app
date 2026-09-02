"""Validate an uploaded PDF and derive the plan's submitted page scope."""
from __future__ import annotations

import io

from pypdf import PdfReader, PdfWriter

from saas.errors import INVALID_UPLOAD, PAGE_LIMIT_PER_JOB_EXCEEDED, SaasError


def prepare_pdf_submission(
    document_bytes: bytes,
    *,
    max_pages: int,
    preview_first_pages: bool,
) -> tuple[bytes, int, int]:
    """Return submitted bytes, source pages, and translated pages."""
    try:
        reader = PdfReader(io.BytesIO(document_bytes))
        source_pages = len(reader.pages)
        if source_pages < 1:
            raise ValueError("PDF contains no pages")
        if source_pages <= max_pages:
            return document_bytes, source_pages, source_pages
        if not preview_first_pages or max_pages < 1:
            raise SaasError(
                PAGE_LIMIT_PER_JOB_EXCEEDED,
                f"This PDF has {source_pages} pages; the limit is {max_pages} pages per job.",
                status_code=422,
                details={"pages": source_pages, "max_pages_per_job": max_pages},
            )
        writer = PdfWriter()
        for page_index in range(max_pages):
            writer.add_page(reader.pages[page_index])
        output = io.BytesIO()
        writer.write(output)
        return output.getvalue(), source_pages, max_pages
    except SaasError:
        raise
    except Exception as exc:
        raise SaasError(
            INVALID_UPLOAD,
            "the uploaded file is not a readable PDF",
            status_code=400,
        ) from exc
