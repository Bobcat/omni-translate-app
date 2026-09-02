"""Create, confirm, and settle owner-bound binding credit quotes."""
from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from app.credits.policy import CreditCostPolicy
from saas.errors import (
    CREDITS_EXHAUSTED,
    PERIOD_QUOTA_EXCEEDED,
    QUOTE_EXPIRED,
    QUOTE_MISMATCH,
    SaasError,
)
from saas.principals import Principal
from saas.storage import SaasStore
from saas.usage import QuotaService, UsageReservation


CREDITS_METRIC = "compute.credits"


@dataclass(frozen=True)
class CreditQuote:
    id: uuid.UUID
    action: str
    payload_hash: str
    pricing_inputs: Mapping[str, Any]
    cost_policy_version: str
    basis: str
    basis_quantity: int
    quoted_credits: int
    expires_at: str
    state: str


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _quote_from_row(row: sqlite3.Row) -> CreditQuote:
    raw_inputs = json.loads(str(row["pricing_inputs"] or "{}"))
    return CreditQuote(
        id=uuid.UUID(row["id"]),
        action=str(row["action"]),
        payload_hash=str(row["payload_hash"]),
        pricing_inputs=dict(raw_inputs) if isinstance(raw_inputs, dict) else {},
        cost_policy_version=str(row["cost_policy_version"]),
        basis=str(row["basis"]),
        basis_quantity=int(row["basis_quantity"]),
        quoted_credits=int(row["quoted_credits"]),
        expires_at=str(row["expires_at"]),
        state=str(row["state"]),
    )


class CreditQuoteService:
    def __init__(
        self,
        *,
        store: SaasStore,
        quota_service: QuotaService,
        policy: CreditCostPolicy,
    ) -> None:
        self._store = store
        self._quota_service = quota_service
        self._policy = policy

    def create(
        self,
        principal: Principal,
        *,
        action: str,
        payload_hash: str,
        pricing_inputs: Mapping[str, Any],
        basis: str,
        basis_quantity: int,
        quoted_credits: int,
        now: datetime | None = None,
        expires_at_override: datetime | None = None,
    ) -> CreditQuote:
        self._policy.require_action(action)
        basis_quantity = int(basis_quantity)
        quoted_credits = int(quoted_credits)
        if basis_quantity < 0:
            raise ValueError("basis_quantity must be >= 0")
        if quoted_credits < 0:
            raise ValueError("quoted_credits must be >= 0")
        created_at = now or _utcnow()
        expires_at = created_at + timedelta(seconds=self._policy.quote_ttl_seconds)
        if expires_at_override is not None:
            if expires_at_override.tzinfo is None:
                raise ValueError("expires_at_override must be timezone-aware")
            expires_at = min(expires_at, expires_at_override)
        quote_id = uuid.uuid4()
        self._store.insert_credit_quote(
            tenant=principal.tenant,
            quote_id=quote_id,
            owner_kind=principal.kind,
            owner_id=principal.id,
            action=action,
            payload_hash=payload_hash,
            pricing_inputs=dict(pricing_inputs),
            cost_policy_version=self._policy.version,
            basis=basis,
            basis_quantity=basis_quantity,
            quoted_credits=quoted_credits,
            expires_at=expires_at.isoformat(),
        )
        row = self._store.get_credit_quote(quote_id)
        if row is None:
            raise RuntimeError("credit quote was not persisted")
        return _quote_from_row(row)

    def require_owner(self, principal: Principal, quote_id: uuid.UUID) -> CreditQuote:
        row = self._store.get_credit_quote(quote_id)
        self._require_match(row, principal=principal)
        assert row is not None
        return _quote_from_row(row)

    def for_operation(
        self,
        principal: Principal,
        operation_id: str,
    ) -> CreditQuote | None:
        row = self._store.get_credit_quote_by_operation(principal.tenant, operation_id)
        if row is None:
            return None
        self._require_match(row, principal=principal, operation_id=operation_id)
        return _quote_from_row(row)

    def confirm(
        self,
        principal: Principal,
        *,
        quote_id: uuid.UUID,
        operation_id: str,
        action: str,
        payload_hash: str,
        credit_limit: int,
        period_kind: str,
        now: datetime | None = None,
    ) -> UsageReservation:
        expired = False
        with self._store.transaction():
            row = self._store.get_credit_quote(quote_id)
            self._require_match(
                row,
                principal=principal,
                action=action,
                payload_hash=payload_hash,
                operation_id=operation_id,
            )
            assert row is not None
            if row["state"] == "confirmed":
                reservation_id = uuid.UUID(str(row["reservation_id"]))
                return self._quota_service.get_reservation(reservation_id)
            current = now or _utcnow()
            if row["state"] == "expired" or current >= datetime.fromisoformat(
                str(row["expires_at"])
            ):
                self._store.expire_credit_quote(quote_id)
                expired = True
            else:
                existing_event = self._store.get_usage_event_by_key(
                    principal.tenant,
                    principal.kind,
                    principal.id,
                    f"credits:{operation_id}",
                )
                if existing_event is not None:
                    raise SaasError(
                        QUOTE_MISMATCH,
                        "operation ID is already bound to another credit quote",
                        status_code=409,
                    )
                try:
                    reservation = self._quota_service.reserve(
                        principal,
                        metric=CREDITS_METRIC,
                        quantity=int(row["quoted_credits"]),
                        limit=int(credit_limit),
                        period_kind=period_kind,
                        job_id=str(operation_id),
                        idempotency_key=f"credits:{operation_id}",
                        now=current,
                        metadata=self._reservation_metadata(row),
                    )
                except SaasError as exc:
                    if exc.code != PERIOD_QUOTA_EXCEEDED:
                        raise
                    details = dict(exc.details)
                    available = max(
                        0,
                        int(details.get("limit", 0))
                        - int(details.get("consumed", 0))
                        - int(details.get("reserved", 0)),
                    )
                    raise SaasError(
                        CREDITS_EXHAUSTED,
                        "not enough credits for this action",
                        status_code=409,
                        details={
                            "required": int(row["quoted_credits"]),
                            "available": available,
                            "period_end": str(details.get("period_end") or ""),
                        },
                    ) from exc
                self._store.confirm_credit_quote(
                    quote_id,
                    operation_id=operation_id,
                    reservation_id=reservation.id,
                )
                return reservation
        if expired:
            raise SaasError(
                QUOTE_EXPIRED,
                "credit quote has expired",
                status_code=409,
                details={"quote_id": str(quote_id)},
            )
        raise RuntimeError("credit quote confirmation ended without a result")

    def consume(
        self,
        principal: Principal,
        quote_id: uuid.UUID,
        *,
        actual_usage: Mapping[str, Any] | None = None,
    ) -> None:
        row = self._require_confirmed_owner(principal, quote_id)
        metadata = {"actual_usage": dict(actual_usage)} if actual_usage is not None else None
        self._quota_service.consume(uuid.UUID(str(row["reservation_id"])), metadata=metadata)

    def release(self, principal: Principal, quote_id: uuid.UUID, *, reason: str) -> None:
        row = self._require_confirmed_owner(principal, quote_id)
        self._quota_service.release(uuid.UUID(str(row["reservation_id"])), reason)

    def _require_confirmed_owner(
        self,
        principal: Principal,
        quote_id: uuid.UUID,
    ) -> sqlite3.Row:
        row = self._store.get_credit_quote(quote_id)
        self._require_match(row, principal=principal)
        assert row is not None
        if row["state"] != "confirmed" or not row["reservation_id"]:
            raise SaasError(QUOTE_MISMATCH, "credit quote is not confirmed", status_code=409)
        return row

    @staticmethod
    def _require_match(
        row: sqlite3.Row | None,
        *,
        principal: Principal,
        action: str | None = None,
        payload_hash: str | None = None,
        operation_id: str | None = None,
    ) -> None:
        matches = bool(
            row is not None
            and row["tenant"] == principal.tenant
            and row["owner_kind"] == principal.kind
            and row["owner_id"] == str(principal.id)
            and (action is None or row["action"] == str(action))
            and (payload_hash is None or row["payload_hash"] == str(payload_hash))
            and (
                operation_id is None
                or not row["operation_id"]
                or row["operation_id"] == str(operation_id)
            )
        )
        if not matches:
            raise SaasError(
                QUOTE_MISMATCH,
                "credit quote does not match this action",
                status_code=409,
            )

    @staticmethod
    def _reservation_metadata(row: sqlite3.Row) -> dict[str, Any]:
        pricing_inputs = json.loads(str(row["pricing_inputs"] or "{}"))
        return {
            "quote_id": str(row["id"]),
            "cost_policy_version": str(row["cost_policy_version"]),
            "action": str(row["action"]),
            "payload_hash": str(row["payload_hash"]),
            "pricing_inputs": dict(pricing_inputs) if isinstance(pricing_inputs, dict) else {},
            "basis": str(row["basis"]),
            "basis_quantity": int(row["basis_quantity"]),
            "quoted_credits": int(row["quoted_credits"]),
            "quote_expires_at": str(row["expires_at"]),
        }
