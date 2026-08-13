"""PDF page quota: the entitlement gate and page reservation around the
expensive upstream translation job.

Counts and reserves pages before an upstream job starts. The browser's
operation id links the reservation to the upstream request before submit, so
retries cannot reserve or queue twice. Terminal settlement consumes completed
and cancelled jobs. It releases pages only for a service-confirmed technical
pipeline failure. An uncertain submit keeps its hold because the upstream job
may already exist.
"""
from __future__ import annotations

import io
import json
import logging
import uuid
from typing import Any, Mapping

from fastapi import Request
from pypdf import PdfReader, PdfWriter

from app.operation_ids import normalize_operation_id
from app.pdf_ownership import PDF_RERENDER_RESOURCE
from app.pdf_translation_bridge import PdfTranslationError
from app.pdf_translation_bridge import submit_pdf
from app.saas_setup import get_saas_context, resolve_request_context
from saas.errors import (
    INVALID_UPLOAD,
    PAGE_LIMIT_PER_JOB_EXCEEDED,
    RESOURCE_NOT_FOUND,
    SaasError,
)

logger = logging.getLogger(__name__)

# The metric the reservation is booked on; the limit/period come from the
# plan entitlements (saas.plans.* in config/settings.json).
PAGES_METRIC = "pdf_translation.pages"

_TERMINAL_STATES = {"completed", "failed", "cancelled"}
_TECHNICAL_FAILURE_CODES = {
    "REQUEST_FAILED",
    "REQUEST_INTERRUPTED_BY_RESTART",
}

_SOURCE_PAGES_METADATA = "pdf_source_pages"
_TRANSLATED_PAGES_METADATA = "pdf_translated_pages"
_PREVIEW_METADATA = "pdf_preview"


def count_pdf_pages(document_bytes: bytes) -> int:
    """Page count of an uploaded PDF. Raises INVALID_UPLOAD (400) when the
    bytes do not parse as a PDF."""
    try:
        return len(PdfReader(io.BytesIO(document_bytes)).pages)
    except Exception as exc:  # pypdf raises several types for malformed input
        raise SaasError(
            INVALID_UPLOAD,
            "the uploaded file is not a readable PDF",
            status_code=400,
        ) from exc


def prepare_pdf_submission(
    document_bytes: bytes,
    *,
    max_pages: int,
    preview_first_pages: bool,
) -> tuple[bytes, int, int]:
    """Return ``(submitted_bytes, source_pages, translated_pages)``.

    A preview-enabled plan submits only the first ``max_pages`` pages. Other
    plans retain the existing hard per-job rejection. The derived document is
    created before quota reservation or upstream work.
    """
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
    except Exception as exc:  # pypdf raises several types for malformed input
        raise SaasError(
            INVALID_UPLOAD,
            "the uploaded file is not a readable PDF",
            status_code=400,
        ) from exc


def attach_pdf_preview(envelope: dict, event: Mapping[str, Any] | None) -> dict:
    """Add app-owned preview metadata from the durable usage event."""
    if event is None:
        return envelope
    try:
        metadata = json.loads(str(event["metadata"] or "{}"))
        if not isinstance(metadata, dict) or not bool(metadata.get(_PREVIEW_METADATA)):
            return envelope
        source_pages = int(metadata.get(_SOURCE_PAGES_METADATA) or 0)
        translated_pages = int(metadata.get(_TRANSLATED_PAGES_METADATA) or 0)
    except (KeyError, TypeError, ValueError):
        return envelope
    if source_pages < 1 or translated_pages < 1 or translated_pages >= source_pages:
        return envelope
    return {
        **envelope,
        "pdf_preview": {
            "source_pages": source_pages,
            "translated_pages": translated_pages,
        },
    }


def submit_pdf_with_quota(
    request: Request,
    *,
    document_bytes: bytes,
    filename: str,
    content_type: str,
    target_language: str,
    operation_id: str,
    render_options: Mapping[str, Any],
) -> tuple[dict, str | None]:
    """Gate, reserve and submit a PDF translation.

    Returns the upstream lifecycle envelope plus the identity-cookie token to
    attach to the route's response (None for bearer-auth users). Raises
    SaasError (invalid operation id, entitlement disabled, invalid upload,
    per-job page cap, period quota) or PdfTranslationError. An uncertain
    upstream submit keeps its reservation: the service may have accepted it.
    """
    ctx = get_saas_context()
    operation_id = normalize_operation_id(operation_id)
    principal, entitlements, identity_token = resolve_request_context(request)
    entitlements.require_enabled("pdf_translation.enabled")
    max_pages = entitlements.get_int("pdf_translation.max_pages_per_job")
    submitted_bytes, source_pages, translated_pages = prepare_pdf_submission(
        document_bytes,
        max_pages=max_pages,
        preview_first_pages=entitlements.is_enabled("pdf_translation.preview_first_pages"),
    )
    reservation = ctx.quota_service.reserve(
        principal,
        metric=PAGES_METRIC,
        quantity=translated_pages,
        limit=entitlements.get_int("pdf_translation.pages_per_period"),
        period_kind=entitlements.get_str("pdf_translation.period", "month"),
        job_id=operation_id,
        idempotency_key=f"pdf-submit:{operation_id}",
        metadata={
            _SOURCE_PAGES_METADATA: source_pages,
            _TRANSLATED_PAGES_METADATA: translated_pages,
            _PREVIEW_METADATA: translated_pages < source_pages,
        },
    )
    envelope = submit_pdf(
        document_bytes=submitted_bytes,
        filename=filename,
        content_type=content_type,
        target_language=target_language,
        operation_id=operation_id,
        render_options=render_options,
    )
    request_id = str(envelope.get("request_id") or "")
    if request_id != operation_id:
        # Acceptance is uncertain, so keep the reservation. Releasing it could
        # make an already-started upstream job free.
        raise PdfTranslationError("translation-services returned an unexpected request_id")
    event = ctx.store.get_usage_event(reservation.id)
    return attach_pdf_preview(envelope, event), identity_token


def require_pdf_request_owner(request: Request, request_id: str) -> Mapping[str, Any] | None:
    """Hide every PDF request not owned by the resolved caller.

    The usage event is the MVP's durable app-side link between a principal and
    an upstream request. Status, cancel and artifact routes all pass through
    this check before revealing whether the upstream id exists.
    """
    ctx = get_saas_context()
    principal, _, _ = resolve_request_context(request)
    event = ctx.store.get_usage_event_by_job_id(
        ctx.tenant,
        str(request_id),
        metric=PAGES_METRIC,
    )
    owned = (
        event is not None
        and event["metric"] == PAGES_METRIC
        and event["owner_kind"] == principal.kind
        and event["owner_id"] == str(principal.id)
    )
    if owned:
        return event
    if ctx.store.resource_is_owned_by(
        ctx.tenant,
        PDF_RERENDER_RESOURCE,
        str(request_id),
        principal.kind,
        principal.id,
    ):
        return None
    raise SaasError(
        RESOURCE_NOT_FOUND,
        "PDF request not found",
        status_code=404,
    )


def settle_pdf_usage_event(event: Mapping[str, Any], envelope: dict) -> str:
    """Apply the PDF settlement policy to one reserved usage event.

    Returns ``consumed``, ``released``, ``reserved`` or ``ignored``. The quota
    service makes repeated terminal settlement safe.
    """
    if str(event["state"]) != "reserved":
        return "ignored"
    request_id = str(envelope.get("request_id") or "")
    if not request_id or request_id != str(event["job_id"] or ""):
        return "ignored"
    state = str(envelope.get("state") or "").lower()
    if state not in _TERMINAL_STATES:
        return "reserved"

    ctx = get_saas_context()
    reservation_id = uuid.UUID(str(event["id"]))
    error = envelope.get("error")
    failure_code = str(error.get("code") or "") if isinstance(error, dict) else ""
    if state == "failed" and failure_code in _TECHNICAL_FAILURE_CODES:
        ctx.quota_service.release(reservation_id, f"technical_failure:{failure_code}")
        return "released"
    if state == "completed":
        reason = "completed"
    elif state == "cancelled":
        reason = "accepted_cancellation"
    else:
        reason = f"non_refundable_failure:{failure_code or 'unclassified'}"
    ctx.quota_service.consume(
        reservation_id,
        metadata={"settlement_reason": reason},
    )
    return "consumed"


def finalize_pdf_reservation(envelope: dict) -> None:
    """Settle the reservation behind an upstream lifecycle envelope.

    No-op for non-terminal states, jobs without a reservation and
    already-settled reservations. Never breaks the status/cancel route that
    called it: bookkeeping failures are logged instead.
    """
    try:
        request_id = str(envelope.get("request_id") or "")
        if not request_id:
            return
        ctx = get_saas_context()
        event = ctx.store.get_usage_event_by_job_id(
            ctx.tenant,
            request_id,
            metric=PAGES_METRIC,
        )
        if event is None:
            return
        settle_pdf_usage_event(event, envelope)
    except Exception:
        logger.warning("could not settle pdf page reservation", exc_info=True)
