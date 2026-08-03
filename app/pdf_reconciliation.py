"""Background settlement of PDF page reservations from durable service state."""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from app.config import get_float
from app.pdf_quota import PAGES_METRIC, settle_pdf_usage_event
from app.pdf_translation_bridge import PdfTranslationError, get_pdf_request
from app.saas_setup import get_saas_context

logger = logging.getLogger(__name__)

_BATCH_SIZE = 100
_DEFAULT_INTERVAL_S = 60.0
_DEFAULT_MISSING_GRACE_S = 24 * 60 * 60


def reconcile_pdf_reservations(
    *,
    now: datetime | None = None,
    missing_grace_s: float | None = None,
) -> int:
    """Settle one batch of reserved PDF usage events.

    A missing service record remains reserved during the grace period. After
    that it is consumed. Transport and service errors leave the hold intact so
    a temporary outage cannot decide billing.
    """
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
        metric=PAGES_METRIC,
        state="reserved",
        limit=_BATCH_SIZE,
    )
    settled = 0
    for event in events:
        request_id = str(event["job_id"] or "")
        if not request_id:
            logger.warning("reserved PDF usage event %s has no job id", event["id"])
            continue
        try:
            envelope = get_pdf_request(request_id)
        except PdfTranslationError as exc:
            if exc.status_code != 404:
                logger.warning("could not reconcile PDF request %s: %s", request_id, exc)
                continue
            try:
                created_at = datetime.fromisoformat(str(event["created_at"]))
                if created_at.tzinfo is None:
                    created_at = created_at.replace(tzinfo=timezone.utc)
                age_s = max(0.0, (current_time - created_at).total_seconds())
            except (TypeError, ValueError):
                logger.warning("reserved PDF usage event %s has an invalid timestamp", event["id"])
                continue
            if age_s < grace_s:
                continue
            ctx.quota_service.consume(
                uuid.UUID(str(event["id"])),
                metadata={"settlement_reason": "missing_service_record_after_grace"},
            )
            settled += 1
            continue
        try:
            outcome = settle_pdf_usage_event(event, envelope)
        except Exception:
            logger.warning("could not settle PDF request %s", request_id, exc_info=True)
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
            await asyncio.to_thread(reconcile_pdf_reservations)
        except Exception:
            logger.exception("PDF quota reconciliation pass failed")
        await asyncio.sleep(interval_s)
