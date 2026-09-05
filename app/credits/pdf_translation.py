"""Owner-bound fixed-price PDF translation from preparation through settlement."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Mapping

from fastapi import Request

from app.credits.quotes import CREDITS_METRIC, CreditQuote
from app.operation_ids import operation_payload_hash
from app.pdf_ownership import record_pdf_credit_owner
from app.pdf_submission import prepare_pdf_submission
from app.pdf_render_options import APP_PDF_RENDER_DEFAULTS
from app.pdf_translation_bridge import (
    PdfTranslationError,
    authorize_pdf_request,
    get_pdf_request,
    prepare_pdf,
)
from app.saas_setup import get_saas_context, resolve_request_context
from app.translation_bridge import translation_language_code
from saas.errors import QUOTE_MISMATCH, RESOURCE_NOT_FOUND, SaasError
from saas.principals import Principal


PDF_CREDIT_OPERATION = "pdf_credit_translation"
PDF_CREDIT_ACTION = "pdf_translation"

_TERMINAL_STATES = {
    "completed",
    "failed",
    "cancelled",
    "cancelled_before_authorization",
}
_TECHNICAL_FAILURE_CODES = {
    "REQUEST_FAILED",
    "REQUEST_INTERRUPTED_BY_RESTART",
}


def submit_pdf_credit_preparation(
    request: Request,
    *,
    document_bytes: bytes,
    filename: str,
    content_type: str,
    operation_id: str,
) -> dict[str, Any]:
    """Validate, stage once upstream, and start source measurement without charging."""
    ctx = _credit_context()
    principal, entitlements, _ = resolve_request_context(request)
    entitlements.require_enabled("pdf_translation.enabled")
    submitted_bytes, source_pages, translated_pages = prepare_pdf_submission(
        document_bytes,
        max_pages=entitlements.get_int("pdf_translation.max_pages_per_job"),
        preview_first_pages=entitlements.is_enabled("pdf_translation.preview_first_pages"),
    )
    render_options = APP_PDF_RENDER_DEFAULTS.model_dump()
    payload_hash = operation_payload_hash(
        "pdf_credit_preparation",
        parameters={
            "translated_pages": str(translated_pages),
            **{key: str(value) for key, value in render_options.items()},
        },
        content=submitted_bytes,
    )
    record_pdf_credit_owner(principal, operation_id, payload_hash)
    snapshot = {
        "plan_code": entitlements.plan_code,
        "payload_hash": payload_hash,
        "source_pages": source_pages,
        "translated_pages": translated_pages,
        "preview": translated_pages < source_pages,
        "filename": filename,
    }
    row = ctx.store.create_quota_operation(
        tenant=ctx.tenant,
        operation_kind=PDF_CREDIT_OPERATION,
        operation_id=operation_id,
        owner_kind=principal.kind,
        owner_id=principal.id,
        metric=CREDITS_METRIC,
        entitlement_snapshot=snapshot,
    )
    _require_operation(row, principal, payload_hash=payload_hash)
    ctx.store.update_quota_operation(
        tenant=ctx.tenant,
        operation_kind=PDF_CREDIT_OPERATION,
        operation_id=operation_id,
        state="preparing",
    )
    envelope = prepare_pdf(
        document_bytes=submitted_bytes,
        filename=filename,
        content_type=content_type,
        operation_id=operation_id,
        render_options=render_options,
    )
    if str(envelope.get("request_id") or "") != operation_id:
        raise PdfTranslationError("translation-services returned an unexpected request_id")
    _update_preparation_state(row, envelope)
    return attach_pdf_credit_context(principal, envelope, operation=row)


def quote_pdf_credit_translation(
    request: Request,
    *,
    request_id: str,
    target_language: str,
) -> dict[str, Any]:
    """Create the target-bound fixed quote from authoritative service measurement."""
    ctx = _credit_context()
    principal, entitlements, _ = resolve_request_context(request)
    operation = require_pdf_credit_operation(principal, request_id)
    envelope = get_pdf_request(request_id)
    _update_preparation_state(operation, envelope)
    if str(envelope.get("state") or "") != "awaiting_quota":
        raise SaasError(
            "PDF_PREPARATION_NOT_READY",
            "PDF preparation has not produced a confirmable source measurement",
            status_code=409,
            details={"request_id": request_id, "state": envelope.get("state")},
        )
    quota = _measured_quota(envelope)
    snapshot = _operation_snapshot(operation)
    pages = int(quota["page_count"])
    if pages != int(snapshot["translated_pages"]):
        raise PdfTranslationError(
            "translation-services measured a different PDF page scope",
            status_code=409,
        )
    target_code = _target_code(target_language)
    payload_hash = _quote_payload_hash(request_id, target_code, quota)
    quoted_credits = ctx.credit_policy.price_pdf_translation(
        pages=pages,
        source_characters=int(quota["source_character_count"]),
    )
    expires_at = _parse_utc(str(quota.get("authorization_expires_at_utc") or ""))
    if expires_at <= datetime.now(timezone.utc):
        raise SaasError(
            "QUOTE_EXPIRED",
            "PDF preparation has expired; upload the document again",
            status_code=409,
            details={"request_id": request_id},
        )
    quote = ctx.credit_quote_service.create(
        principal,
        action=PDF_CREDIT_ACTION,
        payload_hash=payload_hash,
        pricing_inputs={
            "request_id": request_id,
            "target_lang_code": target_code,
            "pages": pages,
            "source_characters": int(quota["source_character_count"]),
            "source_character_counting_version": quota[
                "source_character_counting_version"
            ],
        },
        basis="pages+source_characters",
        basis_quantity=pages,
        quoted_credits=quoted_credits,
        expires_at_override=expires_at,
    )
    available, period_end = _available_credits(principal, entitlements)
    return {
        "request_id": request_id,
        "quote": _quote_payload(
            quote,
            target_language=target_language,
            target_lang_code=target_code,
            available=available,
            period_end=period_end,
        ),
        "pdf_scope": _pdf_scope(snapshot),
    }


def confirm_pdf_credit_translation(
    request: Request,
    *,
    request_id: str,
    quote_id: str,
    target_language: str,
) -> dict[str, Any]:
    """Reserve the displayed credits and authorize the already-staged service job."""
    ctx = _credit_context()
    principal, entitlements, _ = resolve_request_context(request)
    operation = require_pdf_credit_operation(principal, request_id)
    envelope = get_pdf_request(request_id)
    quota = _measured_quota(envelope)
    target_code = _target_code(target_language)
    payload_hash = _quote_payload_hash(request_id, target_code, quota)
    try:
        parsed_quote_id = uuid.UUID(str(quote_id))
    except ValueError as exc:
        raise SaasError(
            QUOTE_MISMATCH,
            "credit quote does not match this PDF translation",
            status_code=409,
        ) from exc
    quote = ctx.credit_quote_service.require_owner(principal, parsed_quote_id)
    ctx.credit_quote_service.confirm(
        principal,
        quote_id=parsed_quote_id,
        operation_id=request_id,
        action=PDF_CREDIT_ACTION,
        payload_hash=payload_hash,
        credit_limit=entitlements.get_int("compute.credits_per_period"),
        period_kind=entitlements.get_str("compute.period"),
    )
    ctx.store.update_quota_operation(
        tenant=ctx.tenant,
        operation_kind=PDF_CREDIT_OPERATION,
        operation_id=request_id,
        state="reserved",
        counting_version=str(quota["source_character_counting_version"]),
        quantity=int(quota["source_character_count"]),
    )
    authorized = authorize_pdf_request(
        request_id,
        counting_version=str(quota["source_character_counting_version"]),
        source_character_count=int(quota["source_character_count"]),
        target_language=target_language,
    )
    if str(authorized.get("request_id") or "") != request_id:
        raise PdfTranslationError("translation-services returned an unexpected request_id")
    settle_pdf_credit_envelope(principal, authorized)
    return attach_pdf_credit_context(principal, authorized, operation=operation, quote=quote)


def require_pdf_credit_operation(principal: Principal, request_id: str) -> Mapping[str, Any]:
    ctx = _credit_context()
    row = ctx.store.get_quota_operation(ctx.tenant, PDF_CREDIT_OPERATION, request_id)
    _require_operation(row, principal)
    assert row is not None
    return row


def resume_pdf_credit_authorization(
    principal: Principal,
    envelope: Mapping[str, Any],
) -> dict[str, Any]:
    """Retry authorization only for an already confirmed credit reservation."""
    body = dict(envelope)
    if str(body.get("state") or "").lower() != "awaiting_quota":
        return body
    ctx = _credit_context()
    request_id = str(body.get("request_id") or "")
    event = ctx.store.get_usage_event_by_job_id(
        ctx.tenant,
        request_id,
        metric=CREDITS_METRIC,
    )
    if event is None or str(event["state"]) != "reserved":
        return body
    quote = ctx.credit_quote_service.for_operation(principal, request_id)
    if quote is None or quote.action != PDF_CREDIT_ACTION:
        raise RuntimeError("credit reservation has no confirmed PDF quote")
    pricing = dict(quote.pricing_inputs)
    try:
        authorized = authorize_pdf_request(
            request_id,
            counting_version=str(pricing["source_character_counting_version"]),
            source_character_count=int(pricing["source_characters"]),
            target_language=str(pricing["target_lang_code"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError("confirmed PDF quote has invalid authorization data") from exc
    if str(authorized.get("request_id") or "") != request_id:
        raise PdfTranslationError("translation-services returned an unexpected request_id")
    return authorized


def settle_pdf_credit_envelope(principal: Principal, envelope: Mapping[str, Any]) -> str:
    """Settle a confirmed PDF quote from durable upstream lifecycle state."""
    ctx = _credit_context()
    request_id = str(envelope.get("request_id") or "")
    event = ctx.store.get_usage_event_by_job_id(
        ctx.tenant,
        request_id,
        metric=CREDITS_METRIC,
    )
    if event is None or str(event["state"]) != "reserved":
        return str(event["state"]) if event is not None else "unconfirmed"
    state = str(envelope.get("state") or "").lower()
    if state not in _TERMINAL_STATES:
        return "reserved"
    quote = ctx.credit_quote_service.for_operation(principal, request_id)
    if quote is None:
        raise RuntimeError("credit reservation has no confirmed quote")
    error = envelope.get("error")
    error_code = str(error.get("code") or "") if isinstance(error, Mapping) else ""
    compute_started = bool((envelope.get("quota") or {}).get("compute_started_at_utc"))
    release_reason = None
    if state == "cancelled_before_authorization" or (state == "cancelled" and not compute_started):
        release_reason = "cancelled_before_compute"
    elif state == "failed" and error_code in _TECHNICAL_FAILURE_CODES:
        release_reason = f"technical_failure:{error_code}"
    if release_reason:
        ctx.credit_quote_service.release(principal, quote.id, reason=release_reason)
        return "released"
    ctx.credit_quote_service.consume(
        principal,
        quote.id,
        actual_usage=_actual_usage(envelope),
    )
    return "consumed"


def attach_pdf_credit_context(
    principal: Principal,
    envelope: Mapping[str, Any],
    *,
    operation: Mapping[str, Any] | None = None,
    quote: CreditQuote | None = None,
) -> dict[str, Any]:
    ctx = _credit_context()
    request_id = str(envelope.get("request_id") or "")
    operation = operation or require_pdf_credit_operation(principal, request_id)
    quote = quote or ctx.credit_quote_service.for_operation(principal, request_id)
    event = ctx.store.get_usage_event_by_job_id(
        ctx.tenant,
        request_id,
        metric=CREDITS_METRIC,
    )
    body = {**dict(envelope), "pdf_scope": _pdf_scope(_operation_snapshot(operation))}
    if quote is not None:
        body["credit_usage"] = {
            "quote_id": str(quote.id),
            "credits": quote.quoted_credits,
            "state": str(event["state"]) if event is not None else "reserved",
        }
    return body


def _credit_context():
    ctx = get_saas_context()
    if not ctx.credit_policy or not ctx.credit_quote_service:
        raise RuntimeError("credit services are unavailable")
    return ctx


def _require_operation(
    row: Mapping[str, Any] | None,
    principal: Principal,
    *,
    payload_hash: str | None = None,
) -> None:
    matches = bool(
        row is not None
        and row["owner_kind"] == principal.kind
        and row["owner_id"] == str(principal.id)
        and row["metric"] == CREDITS_METRIC
    )
    if not matches:
        raise SaasError(RESOURCE_NOT_FOUND, "PDF request not found", status_code=404)
    if payload_hash is not None and _operation_snapshot(row).get("payload_hash") != payload_hash:
        raise SaasError(
            "OPERATION_IDEMPOTENCY_CONFLICT",
            "PDF operation ID was already used for a different document",
            status_code=409,
        )


def _operation_snapshot(row: Mapping[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(str(row["entitlement_snapshot"] or "{}"))
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("PDF credit operation has invalid metadata") from exc
    if not isinstance(value, dict):
        raise RuntimeError("PDF credit operation has invalid metadata")
    return value


def _update_preparation_state(operation: Mapping[str, Any], envelope: Mapping[str, Any]) -> None:
    state = str(envelope.get("state") or "")
    quota = envelope.get("quota") if isinstance(envelope.get("quota"), Mapping) else {}
    ctx = _credit_context()
    ctx.store.update_quota_operation(
        tenant=ctx.tenant,
        operation_kind=PDF_CREDIT_OPERATION,
        operation_id=str(operation["operation_id"]),
        state="measured" if state == "awaiting_quota" else state or "preparing",
        counting_version=str(quota.get("source_character_counting_version") or "") or None,
        quantity=(
            int(quota["source_character_count"])
            if isinstance(quota.get("source_character_count"), int)
            else None
        ),
    )


def _measured_quota(envelope: Mapping[str, Any]) -> dict[str, Any]:
    quota = envelope.get("quota")
    if not isinstance(quota, Mapping):
        raise SaasError(
            "PDF_PREPARATION_NOT_READY",
            "PDF preparation has not produced a source measurement",
            status_code=409,
        )
    required = (
        "source_character_counting_version",
        "source_character_count",
        "page_count",
        "authorization_expires_at_utc",
    )
    if any(key not in quota for key in required):
        raise PdfTranslationError("translation-services returned an incomplete PDF measurement")
    return dict(quota)


def _quote_payload_hash(
    request_id: str,
    target_lang_code: str,
    quota: Mapping[str, Any],
) -> str:
    return operation_payload_hash(
        PDF_CREDIT_ACTION,
        parameters={
            "request_id": request_id,
            "target_lang_code": target_lang_code,
            "pages": str(int(quota["page_count"])),
            "source_characters": str(int(quota["source_character_count"])),
            "source_character_counting_version": str(
                quota["source_character_counting_version"]
            ),
        },
    )


def _quote_payload(
    quote: CreditQuote,
    *,
    target_language: str,
    target_lang_code: str,
    available: int,
    period_end: str,
) -> dict[str, Any]:
    pricing = dict(quote.pricing_inputs)
    return {
        "id": str(quote.id),
        "credits": quote.quoted_credits,
        "target_language": target_language,
        "target_lang_code": target_lang_code,
        "pages": int(pricing["pages"]),
        "source_characters": int(pricing["source_characters"]),
        "cost_policy_version": quote.cost_policy_version,
        "expires_at": quote.expires_at,
        "available": available,
        "remaining_after_confirmation": max(0, available - quote.quoted_credits),
        "period_end": period_end,
    }


def _available_credits(principal: Principal, entitlements) -> tuple[int, str]:
    ctx = _credit_context()
    summary = ctx.quota_service.get_usage(
        principal,
        CREDITS_METRIC,
        entitlements.get_str("compute.period"),
    )
    limit = entitlements.get_int("compute.credits_per_period")
    return max(0, limit - summary.reserved - summary.consumed), summary.period_end


def _target_code(target_language: str) -> str:
    try:
        target_code = translation_language_code(target_language)
    except ValueError as exc:
        raise PdfTranslationError(str(exc), status_code=400) from exc
    if not target_code:
        raise PdfTranslationError("target language is required", status_code=400)
    return target_code


def _parse_utc(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise PdfTranslationError("translation-services returned an invalid quote expiry") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _pdf_scope(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "source_pages": int(snapshot["source_pages"]),
        "translated_pages": int(snapshot["translated_pages"]),
        "preview": bool(snapshot["preview"]),
    }


def _actual_usage(envelope: Mapping[str, Any]) -> dict[str, Any]:
    response = envelope.get("response")
    if not isinstance(response, Mapping):
        return {}
    metadata = response.get("metadata") if isinstance(response.get("metadata"), Mapping) else {}
    metrics = response.get("metrics") if isinstance(response.get("metrics"), Mapping) else {}
    return {
        "source_character_counting_version": metadata.get(
            "source_character_counting_version"
        ),
        "source_character_count": metadata.get("source_character_count"),
        "page_count": metadata.get("page_count"),
        "translate_pdf_total_wall_ms": metrics.get("translate_pdf_total_wall_ms"),
    }
