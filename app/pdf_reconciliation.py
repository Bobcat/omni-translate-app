"""Settle reserved PDF credits from durable translation-service state."""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from app.config import get_float
from app.credits.pdf_translation import settle_pdf_credit_envelope
from app.credits.quotes import CREDITS_METRIC
from app.pdf_translation_bridge import PdfTranslationError, get_pdf_request
from app.saas_setup import get_saas_context
from saas.principals import Principal

logger = logging.getLogger(__name__)

_BATCH_SIZE = 100
_DEFAULT_INTERVAL_S = 60.0
_DEFAULT_MISSING_GRACE_S = 24 * 60 * 60


def reconcile_pdf_credit_reservations(
    *,
    now: datetime | None = None,
    missing_grace_s: float | None = None,
) -> int:
    """Settle confirmed PDF credit holds without browser polling."""
    ctx = get_saas_context()
    current_time = now or datetime.now(timezone.utc)
    grace_s = (
        get_float(
            "pdf_translation.reconciliation_missing_grace_s",
            _DEFAULT_MISSING_GRACE_S,
            min_value=0,
        )
        if missing_grace_s is None
        else max(0.0, float(missing_grace_s))
    )
    events = ctx.store.list_usage_events(
        ctx.tenant,
        metric=CREDITS_METRIC,
        state="reserved",
        limit=_BATCH_SIZE,
    )
    settled = 0
    for event in events:
        request_id = str(event["job_id"] or "")
        if not request_id:
            logger.warning("reserved PDF credit event %s has no job id", event["id"])
            continue
        try:
            envelope = get_pdf_request(request_id)
        except PdfTranslationError as exc:
            if exc.status_code != 404:
                logger.warning("could not reconcile PDF credit request %s: %s", request_id, exc)
                continue
            try:
                created_at = datetime.fromisoformat(str(event["created_at"]))
                if created_at.tzinfo is None:
                    created_at = created_at.replace(tzinfo=timezone.utc)
                age_s = max(0.0, (current_time - created_at).total_seconds())
            except (TypeError, ValueError):
                logger.warning(
                    "reserved PDF credit event %s has an invalid timestamp",
                    event["id"],
                )
                continue
            if age_s < grace_s:
                continue
            ctx.quota_service.release(
                uuid.UUID(str(event["id"])),
                "missing_service_record_after_grace",
            )
            settled += 1
            continue
        principal = Principal(
            tenant=str(event["tenant"]),
            kind=str(event["owner_kind"]),
            id=uuid.UUID(str(event["owner_id"])),
            plan_code="",
        )
        try:
            outcome = settle_pdf_credit_envelope(principal, envelope)
        except Exception:
            logger.warning("could not settle PDF credit request %s", request_id, exc_info=True)
            continue
        if outcome in {"consumed", "released"}:
            settled += 1
    return settled


async def run_pdf_reconciliation_loop() -> None:
    """Run one reconciliation pass immediately, then repeat until shutdown."""
    interval_s = get_float(
        "pdf_translation.reconciliation_interval_s",
        _DEFAULT_INTERVAL_S,
        min_value=1.0,
    )
    while True:
        try:
            await asyncio.to_thread(reconcile_pdf_credit_reservations)
        except Exception:
            logger.exception("PDF credit reconciliation pass failed")
        await asyncio.sleep(interval_s)
