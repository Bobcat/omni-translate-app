"""PDF page quota: the entitlement gate and page reservation around the
expensive upstream translation job.

Follows the free-PDF flow in plan/saas-foundation-entitlements.md §11: count
pages at submit, enforce the per-job cap, reserve the pages BEFORE the
upstream job starts, then consume on completion and release on failure or
cancel — a failure on our side never costs the user quota. The reservation
is linked to the upstream request id (known only after the submit) so the
poll and cancel routes can settle it.

Partial-success deviation from plan §11 step 11: the service does not
deliver partial artifacts today, so a failed run releases the whole
reservation — consuming finished-but-undelivered pages would charge the
user for nothing. Revisit when the service preserves partial results.
"""
from __future__ import annotations

import io
import logging
import uuid

from fastapi import Request
from pypdf import PdfReader

from app.pdf_translation_bridge import submit_pdf
from app.saas_setup import get_saas_context, resolve_request_context
from saas.errors import INVALID_UPLOAD, PAGE_LIMIT_PER_JOB_EXCEEDED, SaasError

logger = logging.getLogger(__name__)

# The metric the reservation is booked on; the limit/period come from the
# plan entitlements (saas.plans.* in config/settings.json).
PAGES_METRIC = "pdf_translation.pages"

_TERMINAL_STATES = {"completed", "failed", "cancelled"}


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


def submit_pdf_with_quota(
    request: Request,
    *,
    document_bytes: bytes,
    filename: str,
    content_type: str,
    target_language: str,
) -> tuple[dict, str | None]:
    """Gate, reserve and submit a PDF translation.

    Returns the upstream lifecycle envelope plus the identity-cookie token to
    attach to the route's response (None for bearer-auth users). Raises
    SaasError (entitlement disabled, invalid upload, per-job page cap, period
    quota) or PdfTranslationError (upstream failure — the reservation is
    released first, so our failure never costs quota).
    """
    ctx = get_saas_context()
    principal, entitlements, identity_token = resolve_request_context(request)
    entitlements.require_enabled("pdf_translation.enabled")
    page_count = count_pdf_pages(document_bytes)
    max_pages = entitlements.get_int("pdf_translation.max_pages_per_job")
    if page_count > max_pages:
        raise SaasError(
            PAGE_LIMIT_PER_JOB_EXCEEDED,
            f"This PDF has {page_count} pages; the limit is {max_pages} pages per job.",
            status_code=422,
            details={"pages": page_count, "max_pages_per_job": max_pages},
        )
    reservation = ctx.quota_service.reserve(
        principal,
        metric=PAGES_METRIC,
        quantity=page_count,
        limit=entitlements.get_int("pdf_translation.pages_per_period"),
        period_kind=entitlements.get_str("pdf_translation.period", "month"),
        idempotency_key=f"pdf-submit:{uuid.uuid4()}",
    )
    try:
        envelope = submit_pdf(
            document_bytes=document_bytes,
            filename=filename,
            content_type=content_type,
            target_language=target_language,
        )
    except Exception:
        ctx.quota_service.release(reservation.id, "submit_failed")
        raise
    request_id = str(envelope.get("request_id") or "")
    if request_id:
        ctx.store.attach_job_to_usage_event(reservation.id, request_id)
    else:
        # Without the id the reservation can never be settled: do not hold it.
        ctx.quota_service.release(reservation.id, "missing_request_id")
    return envelope, identity_token


def finalize_pdf_reservation(envelope: dict) -> None:
    """Settle the reservation behind a terminal envelope: consume on
    completion, release on failure/cancel. No-op for non-terminal states,
    jobs without a reservation (pre-quota, or another tenant's) and
    already-settled reservations, so the poll route can call this on every
    tick. Never breaks its caller: a bookkeeping failure is logged, not
    raised into a user-facing poll."""
    try:
        state = str(envelope.get("state") or "").lower()
        if state not in _TERMINAL_STATES:
            return
        request_id = str(envelope.get("request_id") or "")
        if not request_id:
            return
        ctx = get_saas_context()
        event = ctx.store.get_usage_event_by_job_id(ctx.tenant, request_id)
        if event is None or event["state"] != "reserved":
            return
        reservation_id = uuid.UUID(event["id"])
        if state == "completed":
            ctx.quota_service.consume(reservation_id)
        else:
            ctx.quota_service.release(reservation_id, state)
    except Exception:
        logger.warning("could not settle pdf page reservation", exc_info=True)
