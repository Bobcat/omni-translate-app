"""Durable operational and character quota for image translation."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Mapping

from app.config import get_float
from app.image_translation_bridge import ImageTranslationError
from app.image_translation_bridge import authorize_image_request
from app.image_translation_bridge import cancel_image_request
from app.image_translation_bridge import get_image_request
from app.saas_setup import get_saas_context
from saas.entitlements import EntitlementSet
from saas.errors import PERIOD_QUOTA_EXCEEDED
from saas.errors import RESOURCE_NOT_FOUND
from saas.errors import USAGE_IDEMPOTENCY_CONFLICT
from saas.errors import SaasError
from saas.principals import Principal

logger = logging.getLogger(__name__)

CHARACTERS_METRIC = "translation.source_characters"
JOBS_METRIC = "image_translation.jobs"
IMAGE_QUOTA_OPERATION = "image_translation"
_IDEMPOTENCY_PREFIX = "image-characters:"
_JOB_IDEMPOTENCY_PREFIX = "image-job:"
_OPEN_STATES = ("created", "awaiting_quota", "reserved", "authorized")
_TERMINAL_STATES = {"completed", "failed", "cancelled", "cancelled_before_authorization"}
_TECHNICAL_FAILURE_CODES = {"REQUEST_FAILED", "REQUEST_INTERRUPTED_BY_RESTART"}
_DEFAULT_INTERVAL_S = 5.0
_DEFAULT_MISSING_GRACE_S = 24 * 60 * 60
_BATCH_SIZE = 100
_MEASUREMENT_KEYS = (
    "source_character_counting_version",
    "source_character_count",
    "source_character_raw_count",
    "source_character_preserved_count",
    "source_character_decoration_count",
)


def reserve_image_job(
    principal: Principal,
    entitlements: EntitlementSet,
    operation_id: str,
    *,
    action: str,
) -> None:
    """Reserve one operational image job before translate or retranslate work."""
    if action not in {"translate", "retranslate"}:
        raise ValueError(f"unsupported image job action: {action}")
    ctx = get_saas_context()
    try:
        ctx.quota_service.reserve(
            principal,
            metric=JOBS_METRIC,
            quantity=1,
            limit=entitlements.get_int("image_translation.jobs_per_period"),
            period_kind=entitlements.get_str("image_translation.period"),
            job_id=operation_id,
            idempotency_key=f"{_JOB_IDEMPOTENCY_PREFIX}{operation_id}",
            metadata={"image_action": action},
        )
    except SaasError as exc:
        if exc.code != PERIOD_QUOTA_EXCEEDED:
            raise
        details = dict(exc.details)
        details["remaining"] = max(
            0,
            int(details.get("limit") or 0)
            - int(details.get("consumed") or 0)
            - int(details.get("reserved") or 0),
        )
        raise SaasError(
            PERIOD_QUOTA_EXCEEDED,
            "No image translation jobs remain in the current quota period. "
            "New translations and retranslations use one job; rerenders do not.",
            status_code=429,
            details=details,
        ) from exc


def register_image_quota_operation(
    principal: Principal,
    entitlements: EntitlementSet,
    operation_id: str,
) -> bool:
    """Persist the original principal and entitlement snapshot when this plan is metered.

    Existing operations keep their original snapshot across retries and config changes.
    Returns whether the service request must use the quota checkpoint.
    """
    ctx = get_saas_context()
    existing = ctx.store.get_quota_operation(
        ctx.tenant,
        IMAGE_QUOTA_OPERATION,
        operation_id,
    )
    if existing is not None:
        _require_operation_owner(existing, principal)
        _raise_stored_rejection(existing)
        return True
    if not entitlements.has("translation.characters_per_period"):
        return False
    snapshot = {
        "plan_code": entitlements.plan_code,
        "entitlements": entitlements.snapshot(),
    }
    row = ctx.store.create_quota_operation(
        tenant=ctx.tenant,
        operation_kind=IMAGE_QUOTA_OPERATION,
        operation_id=operation_id,
        owner_kind=principal.kind,
        owner_id=principal.id,
        metric=CHARACTERS_METRIC,
        entitlement_snapshot=snapshot,
    )
    _require_operation_owner(row, principal)
    return True


def handle_image_quota_lifecycle(
    operation_id: str,
    envelope: Mapping[str, Any],
    *,
    raise_quota_errors: bool = False,
) -> str:
    """Advance one durable operation from a translation-services lifecycle response."""
    ctx = get_saas_context()
    row = ctx.store.get_quota_operation(ctx.tenant, IMAGE_QUOTA_OPERATION, operation_id)
    if row is None:
        return "unmetered"
    request_id = str(envelope.get("request_id") or "")
    if request_id != str(operation_id):
        raise ImageTranslationError(
            "translation-services returned an unexpected request_id",
            status_code=409,
        )
    state = str(envelope.get("state") or "").lower()
    if state == "awaiting_quota":
        return _reserve_and_authorize(
            row,
            envelope,
            raise_quota_errors=raise_quota_errors,
        )
    if state in {"completed", "failed", "cancelled", "cancelled_before_authorization"}:
        return _settle(row, envelope)
    if state in {"queued", "running"} and str(row["state"]) == "reserved":
        ctx.store.update_quota_operation(
            tenant=ctx.tenant,
            operation_kind=IMAGE_QUOTA_OPERATION,
            operation_id=operation_id,
            state="authorized",
        )
        return "authorized"
    return "pending"


def handle_image_operation_lifecycle(
    operation_id: str,
    envelope: Mapping[str, Any],
    *,
    raise_quota_errors: bool = False,
) -> str:
    """Settle the operational job and advance any character authorization."""
    job_outcome = settle_image_job_reservation(operation_id, envelope)
    character_outcome = handle_image_quota_lifecycle(
        operation_id,
        envelope,
        raise_quota_errors=raise_quota_errors,
    )
    return job_outcome if character_outcome == "unmetered" else character_outcome


def settle_image_job_reservation(
    operation_id: str,
    envelope: Mapping[str, Any],
) -> str:
    """Apply the image-job settlement policy to one lifecycle response."""
    event = _image_job_event(operation_id)
    if event is None:
        return "unmetered"
    request_id = str(envelope.get("request_id") or "")
    if request_id != str(operation_id):
        raise ImageTranslationError(
            "translation-services returned an unexpected request_id",
            status_code=409,
        )
    if str(event["state"]) != "reserved":
        return "ignored"
    state = str(envelope.get("state") or "").lower()
    if state not in _TERMINAL_STATES:
        return "reserved"

    ctx = get_saas_context()
    reservation_id = uuid.UUID(str(event["id"]))
    error = envelope.get("error")
    error_code = str(error.get("code") or "") if isinstance(error, Mapping) else ""
    if state == "failed" and error_code in _TECHNICAL_FAILURE_CODES:
        ctx.quota_service.release(reservation_id, f"technical_failure:{error_code}")
        return "released"
    ctx.quota_service.consume(
        reservation_id,
        metadata={"settlement_reason": _job_settlement_reason(state, error_code)},
    )
    return "consumed"


def reconcile_image_quota_operations(
    *,
    now: datetime | None = None,
    missing_grace_s: float | None = None,
) -> int:
    """Advance open image quota operations without any browser/session state."""
    ctx = get_saas_context()
    current_time = now or datetime.now(timezone.utc)
    grace_s = (
        get_float(
            "image_translation.quota_reconciliation_missing_grace_s",
            _DEFAULT_MISSING_GRACE_S,
            min_value=0,
        )
        if missing_grace_s is None
        else max(0.0, float(missing_grace_s))
    )
    rows = ctx.store.list_quota_operations(
        ctx.tenant,
        operation_kind=IMAGE_QUOTA_OPERATION,
        states=_OPEN_STATES,
        limit=_BATCH_SIZE,
    )
    advanced = 0
    for row in rows:
        operation_id = str(row["operation_id"])
        try:
            envelope = get_image_request(operation_id)
        except ImageTranslationError as exc:
            if exc.status_code != 404:
                logger.warning("could not reconcile image request %s: %s", operation_id, exc)
                continue
            if not _missing_grace_elapsed(row, current_time, grace_s):
                continue
            _settle_missing_operation(row)
            advanced += 1
            continue
        try:
            outcome = handle_image_operation_lifecycle(operation_id, envelope)
        except Exception:
            logger.warning("could not reconcile image request %s", operation_id, exc_info=True)
            continue
        if outcome not in {"pending", "unmetered"}:
            advanced += 1
    return advanced


def reconcile_image_job_reservations(
    *,
    now: datetime | None = None,
    missing_grace_s: float | None = None,
) -> int:
    """Settle operational job reservations from durable service status."""
    ctx = get_saas_context()
    current_time = now or datetime.now(timezone.utc)
    grace_s = (
        get_float(
            "image_translation.quota_reconciliation_missing_grace_s",
            _DEFAULT_MISSING_GRACE_S,
            min_value=0,
        )
        if missing_grace_s is None
        else max(0.0, float(missing_grace_s))
    )
    events = ctx.store.list_usage_events(
        ctx.tenant,
        metric=JOBS_METRIC,
        state="reserved",
        limit=_BATCH_SIZE,
    )
    settled = 0
    for event in events:
        operation_id = str(event["job_id"] or "")
        if not operation_id:
            logger.warning("reserved image-job usage event %s has no job id", event["id"])
            continue
        try:
            envelope = get_image_request(operation_id)
        except ImageTranslationError as exc:
            if exc.status_code != 404:
                logger.warning("could not reconcile image job %s: %s", operation_id, exc)
                continue
            if not _missing_grace_elapsed(event, current_time, grace_s):
                continue
            ctx.quota_service.consume(
                uuid.UUID(str(event["id"])),
                metadata={"settlement_reason": "missing_service_record_after_grace"},
            )
            settled += 1
            continue
        try:
            outcome = settle_image_job_reservation(operation_id, envelope)
        except Exception:
            logger.warning("could not settle image job %s", operation_id, exc_info=True)
            continue
        if outcome in {"consumed", "released"}:
            settled += 1
    return settled


async def run_image_quota_reconciliation_loop() -> None:
    """Run one recovery pass immediately and then periodically until shutdown."""
    interval_s = get_float(
        "image_translation.quota_reconciliation_interval_s",
        _DEFAULT_INTERVAL_S,
        min_value=1.0,
    )
    while True:
        try:
            await asyncio.to_thread(reconcile_image_quota_operations)
        except Exception:
            logger.exception("image character-quota reconciliation pass failed")
        try:
            await asyncio.to_thread(reconcile_image_job_reservations)
        except Exception:
            logger.exception("image job-quota reconciliation pass failed")
        await asyncio.sleep(interval_s)


def _reserve_and_authorize(
    row: Mapping[str, Any],
    envelope: Mapping[str, Any],
    *,
    raise_quota_errors: bool,
) -> str:
    ctx = get_saas_context()
    operation_id = str(row["operation_id"])
    measurement = _measurement(envelope.get("quota"))
    _require_stable_measurement(row, measurement)
    ctx.store.update_quota_operation(
        tenant=ctx.tenant,
        operation_kind=IMAGE_QUOTA_OPERATION,
        operation_id=operation_id,
        state="awaiting_quota",
        counting_version=str(measurement["source_character_counting_version"]),
        quantity=int(measurement["source_character_count"]),
    )
    snapshot = _snapshot(row)
    entitlements = dict(snapshot["entitlements"])
    principal = Principal(
        tenant=str(row["tenant"]),
        kind=str(row["owner_kind"]),
        id=uuid.UUID(str(row["owner_id"])),
        plan_code=str(snapshot["plan_code"]),
    )
    idempotency_key = f"{_IDEMPOTENCY_PREFIX}{operation_id}"
    existing = ctx.store.get_usage_event_by_key(
        principal.tenant,
        principal.kind,
        principal.id,
        idempotency_key,
    )
    if existing is not None:
        _require_counting_version(existing, measurement)
    try:
        ctx.quota_service.reserve(
            principal,
            metric=CHARACTERS_METRIC,
            quantity=int(measurement["source_character_count"]),
            limit=int(entitlements["translation.characters_per_period"]),
            period_kind=str(entitlements.get("translation.period") or "month"),
            job_id=operation_id,
            idempotency_key=idempotency_key,
            metadata=measurement,
        )
    except SaasError as exc:
        if exc.code != PERIOD_QUOTA_EXCEEDED:
            raise
        rejection = _quota_exceeded_error(exc.details)
        try:
            cancelled = cancel_image_request(operation_id)
            settle_image_job_reservation(operation_id, cancelled)
        except ImageTranslationError:
            logger.warning("could not cancel over-quota image request %s", operation_id)
        ctx.store.update_quota_operation(
            tenant=ctx.tenant,
            operation_kind=IMAGE_QUOTA_OPERATION,
            operation_id=operation_id,
            state="rejected",
            counting_version=str(measurement["source_character_counting_version"]),
            quantity=int(measurement["source_character_count"]),
            error_code=rejection.code,
            error_details=rejection.details,
        )
        if raise_quota_errors:
            raise rejection
        return "rejected"
    ctx.store.update_quota_operation(
        tenant=ctx.tenant,
        operation_kind=IMAGE_QUOTA_OPERATION,
        operation_id=operation_id,
        state="reserved",
        counting_version=str(measurement["source_character_counting_version"]),
        quantity=int(measurement["source_character_count"]),
    )
    authorized = authorize_image_request(
        operation_id,
        counting_version=str(measurement["source_character_counting_version"]),
        source_character_count=int(measurement["source_character_count"]),
    )
    authorized_state = str(authorized.get("state") or "").lower()
    if authorized_state in {
        "completed",
        "failed",
        "cancelled",
        "cancelled_before_authorization",
    }:
        settle_image_job_reservation(operation_id, authorized)
        return _settle(row, authorized)
    if authorized_state == "awaiting_quota":
        return "reserved"
    if authorized_state not in {"queued", "running"}:
        raise ImageTranslationError(
            "translation-services returned an invalid authorization state"
        )
    ctx.store.update_quota_operation(
        tenant=ctx.tenant,
        operation_kind=IMAGE_QUOTA_OPERATION,
        operation_id=operation_id,
        state="authorized",
        counting_version=str(measurement["source_character_counting_version"]),
        quantity=int(measurement["source_character_count"]),
    )
    return "authorized"


def _settle(row: Mapping[str, Any], envelope: Mapping[str, Any]) -> str:
    ctx = get_saas_context()
    operation_id = str(row["operation_id"])
    event = _usage_event(row)
    state = str(envelope.get("state") or "").lower()
    error = envelope.get("error")
    error_code = str(error.get("code") or "") if isinstance(error, Mapping) else ""
    outcome = state
    if event is not None and str(event["state"]) == "reserved":
        reservation_id = uuid.UUID(str(event["id"]))
        if state == "cancelled_before_authorization":
            ctx.quota_service.release(reservation_id, "cancelled_before_authorization")
            outcome = "released"
        elif state == "failed" and error_code in _TECHNICAL_FAILURE_CODES:
            ctx.quota_service.release(reservation_id, f"technical_failure:{error_code}")
            outcome = "released"
        else:
            ctx.quota_service.consume(
                reservation_id,
                metadata={"settlement_reason": _settlement_reason(state, error_code)},
            )
            outcome = "consumed"
    ctx.store.update_quota_operation(
        tenant=ctx.tenant,
        operation_kind=IMAGE_QUOTA_OPERATION,
        operation_id=operation_id,
        state=state or "failed",
        error_code=error_code or None,
    )
    return outcome


def _settle_missing_operation(row: Mapping[str, Any]) -> None:
    ctx = get_saas_context()
    event = _usage_event(row)
    if event is not None and str(event["state"]) == "reserved":
        ctx.quota_service.consume(
            uuid.UUID(str(event["id"])),
            metadata={"settlement_reason": "missing_service_record_after_grace"},
        )
    ctx.store.update_quota_operation(
        tenant=ctx.tenant,
        operation_kind=IMAGE_QUOTA_OPERATION,
        operation_id=str(row["operation_id"]),
        state="missing",
        error_code="REQUEST_NOT_FOUND_AFTER_GRACE",
    )


def _usage_event(row: Mapping[str, Any]):
    ctx = get_saas_context()
    return ctx.store.get_usage_event_by_key(
        str(row["tenant"]),
        str(row["owner_kind"]),
        uuid.UUID(str(row["owner_id"])),
        f"{_IDEMPOTENCY_PREFIX}{row['operation_id']}",
    )


def _image_job_event(operation_id: str):
    ctx = get_saas_context()
    return ctx.store.get_usage_event_by_job_id(
        ctx.tenant,
        str(operation_id),
        metric=JOBS_METRIC,
    )


def _measurement(value: Any) -> dict[str, Any]:
    quota = dict(value) if isinstance(value, Mapping) else {}
    version = str(quota.get("source_character_counting_version") or "").strip()
    count = quota.get("source_character_count")
    if not version or not isinstance(count, int) or isinstance(count, bool) or count < 0:
        raise ImageTranslationError("translation-services returned an invalid source measurement")
    result: dict[str, Any] = {
        "source_character_counting_version": version,
        "source_character_count": count,
    }
    for key in _MEASUREMENT_KEYS[2:]:
        item = quota.get(key)
        if isinstance(item, int) and not isinstance(item, bool) and item >= 0:
            result[key] = item
    return result


def _snapshot(row: Mapping[str, Any]) -> dict[str, Any]:
    try:
        snapshot = json.loads(str(row["entitlement_snapshot"]))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("quota operation has an invalid entitlement snapshot") from exc
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("entitlements"), dict):
        raise RuntimeError("quota operation has an invalid entitlement snapshot")
    return snapshot


def _require_operation_owner(row: Mapping[str, Any], principal: Principal) -> None:
    if (
        str(row["owner_kind"]) == principal.kind
        and str(row["owner_id"]) == str(principal.id)
        and str(row["metric"]) == CHARACTERS_METRIC
    ):
        return
    raise SaasError(RESOURCE_NOT_FOUND, "image operation not found", status_code=404)


def _raise_stored_rejection(row: Mapping[str, Any]) -> None:
    if str(row["state"]) != "rejected" or str(row["error_code"] or "") != PERIOD_QUOTA_EXCEEDED:
        return
    try:
        details = json.loads(str(row["error_details"] or "{}"))
    except ValueError:
        details = {}
    raise _quota_exceeded_error(details if isinstance(details, dict) else {})


def _quota_exceeded_error(details: Mapping[str, Any]) -> SaasError:
    requested = max(0, int(details.get("requested") or 0))
    remaining = max(
        0,
        int(details.get("limit") or 0)
        - int(details.get("consumed") or 0)
        - int(details.get("reserved") or 0),
    )
    message = (
        f"This image needs about {requested:,} translation characters, "
        f"but only {remaining:,} remain this month."
    )
    return SaasError(
        PERIOD_QUOTA_EXCEEDED,
        message,
        status_code=429,
        details=dict(details),
    )


def _require_stable_measurement(
    row: Mapping[str, Any],
    measurement: Mapping[str, Any],
) -> None:
    prior_version = str(row["counting_version"] or "")
    prior_quantity = row["quantity"]
    if prior_version and prior_version != str(measurement["source_character_counting_version"]):
        raise SaasError(
            USAGE_IDEMPOTENCY_CONFLICT,
            "operation source-character measurement changed",
            status_code=409,
        )
    if prior_quantity is not None and int(prior_quantity) != int(measurement["source_character_count"]):
        raise SaasError(
            USAGE_IDEMPOTENCY_CONFLICT,
            "operation source-character measurement changed",
            status_code=409,
        )


def _require_counting_version(event: Mapping[str, Any], measurement: Mapping[str, Any]) -> None:
    try:
        metadata = json.loads(str(event["metadata"] or "{}"))
    except ValueError:
        metadata = {}
    if (
        isinstance(metadata, dict)
        and metadata.get("source_character_counting_version")
        == measurement["source_character_counting_version"]
    ):
        return
    raise SaasError(
        USAGE_IDEMPOTENCY_CONFLICT,
        "usage reservation has a different source-character counting version",
        status_code=409,
    )


def _missing_grace_elapsed(
    row: Mapping[str, Any],
    now: datetime,
    grace_s: float,
) -> bool:
    try:
        created_at = datetime.fromisoformat(str(row["created_at"]))
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        identifier = row["operation_id"] if "operation_id" in row.keys() else row["job_id"]
        logger.warning("image quota record %s has an invalid timestamp", identifier)
        return False
    return max(0.0, (now - created_at).total_seconds()) >= grace_s


def _settlement_reason(state: str, error_code: str) -> str:
    if state == "completed":
        return "completed"
    if state == "cancelled":
        return "accepted_cancellation"
    return f"non_refundable_failure:{error_code or 'unclassified'}"


def _job_settlement_reason(state: str, error_code: str) -> str:
    if state == "completed":
        return "completed"
    if state in {"cancelled", "cancelled_before_authorization"}:
        return "accepted_cancellation"
    return f"non_refundable_failure:{error_code or 'unclassified'}"
