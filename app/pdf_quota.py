"""PDF page quota: the entitlement gate and page reservation around the
expensive upstream translation job.

Follows the free-PDF flow in plan/saas-foundation-entitlements.md §11: count
pages at submit, enforce the per-job cap, reserve the pages BEFORE the
upstream job starts, then consume on completion and release on failure or
cancel. The browser's operation id links the reservation to the upstream
request before submit, so retries cannot reserve or queue twice. An uncertain
submit keeps its hold because the upstream job may already exist.

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

from app.pdf_translation_bridge import PdfTranslationError
from app.pdf_translation_bridge import submit_pdf
from app.saas_setup import get_saas_context, resolve_request_context
from saas.errors import (
    INVALID_OPERATION_ID,
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


def normalize_operation_id(value: str | None) -> str:
    """Canonical random UUID supplied by the browser for one explicit action."""
    try:
        operation_id = uuid.UUID(str(value or "").strip())
    except (ValueError, AttributeError) as exc:
        raise SaasError(
            INVALID_OPERATION_ID,
            "Idempotency-Key must be a UUID",
            status_code=400,
        ) from exc
    if operation_id.version != 4:
        raise SaasError(
            INVALID_OPERATION_ID,
            "Idempotency-Key must be a random UUID",
            status_code=400,
        )
    return str(operation_id)


def submit_pdf_with_quota(
    request: Request,
    *,
    document_bytes: bytes,
    filename: str,
    content_type: str,
    target_language: str,
    operation_id: str,
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
    page_count = count_pdf_pages(document_bytes)
    max_pages = entitlements.get_int("pdf_translation.max_pages_per_job")
    if page_count > max_pages:
        raise SaasError(
            PAGE_LIMIT_PER_JOB_EXCEEDED,
            f"This PDF has {page_count} pages; the limit is {max_pages} pages per job.",
            status_code=422,
            details={"pages": page_count, "max_pages_per_job": max_pages},
        )
    ctx.quota_service.reserve(
        principal,
        metric=PAGES_METRIC,
        quantity=page_count,
        limit=entitlements.get_int("pdf_translation.pages_per_period"),
        period_kind=entitlements.get_str("pdf_translation.period", "month"),
        job_id=operation_id,
        idempotency_key=f"pdf-submit:{operation_id}",
    )
    envelope = submit_pdf(
        document_bytes=document_bytes,
        filename=filename,
        content_type=content_type,
        target_language=target_language,
        operation_id=operation_id,
    )
    request_id = str(envelope.get("request_id") or "")
    if request_id != operation_id:
        # Acceptance is uncertain, so keep the reservation. Releasing it could
        # make an already-started upstream job free.
        raise PdfTranslationError("translation-services returned an unexpected request_id")
    return envelope, identity_token


def require_pdf_request_owner(request: Request, request_id: str) -> None:
    """Hide every PDF request not owned by the resolved caller.

    The usage event is the MVP's durable app-side link between a principal and
    an upstream request. Status, cancel and artifact routes all pass through
    this check before revealing whether the upstream id exists.
    """
    ctx = get_saas_context()
    principal, _, _ = resolve_request_context(request)
    event = ctx.store.get_usage_event_by_job_id(ctx.tenant, str(request_id))
    owned = (
        event is not None
        and event["metric"] == PAGES_METRIC
        and event["owner_kind"] == principal.kind
        and event["owner_id"] == str(principal.id)
    )
    if not owned:
        raise SaasError(
            RESOURCE_NOT_FOUND,
            "PDF request not found",
            status_code=404,
        )


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
