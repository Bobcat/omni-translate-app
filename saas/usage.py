"""Quota: atomic reserve / consume / release against the usage ledger.

Domain-free on purpose: the caller supplies the metric, quantity, period and
limit (resolved from entitlements). The invariant the host must keep: every
expensive job gets an idempotent reservation BEFORE entering its expensive
stage. This service guarantees two concurrent reserves cannot spend the same
remaining quota, and that retrying with the same idempotency key never
double-reserves.
"""
from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from saas.errors import PERIOD_QUOTA_EXCEEDED, USAGE_IDEMPOTENCY_CONFLICT, SaasError
from saas.periods import UsagePeriodKind, period_bounds
from saas.principals import Principal
from saas.storage import SaasStore


@dataclass(frozen=True)
class UsageReservation:
    id: uuid.UUID
    idempotency_key: str
    metric: str
    quantity: int
    state: str
    period_start: str
    period_end: str


@dataclass(frozen=True)
class UsageSummary:
    metric: str
    period_kind: str
    period_start: str
    period_end: str
    reserved: int
    consumed: int


def _reservation_from_row(row: sqlite3.Row) -> UsageReservation:
    return UsageReservation(
        id=uuid.UUID(row["id"]),
        idempotency_key=row["idempotency_key"],
        metric=row["metric"],
        quantity=int(row["quantity"]),
        state=row["state"],
        period_start=row["period_start"] or "",
        period_end=row["period_end"] or "",
    )


def _validate_idempotent_replay(
    row: sqlite3.Row,
    *,
    idempotency_key: str,
    metric: str,
    quantity: int,
    period_kind: str,
    period_start: str,
    period_end: str,
    job_id: str | None,
) -> None:
    existing_job_id = str(row["job_id"] or "")
    requested_job_id = str(job_id or "")
    matches = (
        row["metric"] == metric
        and int(row["quantity"]) == quantity
        and row["period_kind"] == period_kind
        and row["period_start"] == period_start
        and row["period_end"] == period_end
        and (not existing_job_id or not requested_job_id or existing_job_id == requested_job_id)
    )
    if matches:
        return
    raise SaasError(
        USAGE_IDEMPOTENCY_CONFLICT,
        "idempotency key was already used for a different usage reservation",
        status_code=409,
        details={"idempotency_key": str(idempotency_key)},
    )


class QuotaService:
    def __init__(self, store: SaasStore) -> None:
        self._store = store

    def get_usage(
        self,
        principal: Principal,
        metric: str,
        period_kind: UsagePeriodKind | str,
        *,
        now: datetime | None = None,
    ) -> UsageSummary:
        kind = UsagePeriodKind(period_kind)
        start, end = period_bounds(kind, now=now)
        return UsageSummary(
            metric=metric,
            period_kind=kind.value,
            period_start=start.isoformat(),
            period_end=end.isoformat(),
            reserved=self._store.get_reserved(
                principal.tenant, principal.kind, principal.id, metric, start.isoformat()
            ),
            consumed=self._store.sum_consumed(
                principal.tenant, principal.kind, principal.id, metric, start.isoformat()
            ),
        )

    def reserve(
        self,
        principal: Principal,
        *,
        metric: str,
        quantity: int,
        limit: int,
        period_kind: UsagePeriodKind | str,
        job_id: str | None = None,
        idempotency_key: str,
        now: datetime | None = None,
    ) -> UsageReservation:
        """Atomically hold ``quantity`` of ``metric`` against ``limit``.

        Idempotent: replaying ``idempotency_key`` returns the original
        reservation without spending again (also under races, via the unique
        key). Raises PERIOD_QUOTA_EXCEEDED (429) when the hold would exceed
        the limit.
        """
        quantity = int(quantity)
        if quantity < 0:
            raise ValueError("quantity must be >= 0")
        kind = UsagePeriodKind(period_kind)
        start, end = period_bounds(kind, now=now)
        existing = self._store.get_usage_event_by_key(
            principal.tenant, principal.kind, principal.id, idempotency_key
        )
        if existing is not None:
            _validate_idempotent_replay(
                existing,
                idempotency_key=idempotency_key,
                metric=metric,
                quantity=quantity,
                period_kind=kind.value,
                period_start=start.isoformat(),
                period_end=end.isoformat(),
                job_id=job_id,
            )
            return _reservation_from_row(existing)
        event_id = uuid.uuid4()
        try:
            with self._store.transaction():
                consumed = self._store.sum_consumed(
                    principal.tenant, principal.kind, principal.id, metric, start.isoformat()
                )
                reserved = self._store.get_reserved(
                    principal.tenant, principal.kind, principal.id, metric, start.isoformat()
                )
                if consumed + reserved + quantity > limit:
                    raise SaasError(
                        PERIOD_QUOTA_EXCEEDED,
                        f"period quota exceeded for {metric}",
                        status_code=429,
                        details={
                            "metric": metric,
                            "limit": limit,
                            "consumed": consumed,
                            "reserved": reserved,
                            "requested": quantity,
                            "period_start": start.isoformat(),
                            "period_end": end.isoformat(),
                        },
                    )
                self._store.insert_usage_event(
                    tenant=principal.tenant,
                    event_id=event_id,
                    idempotency_key=idempotency_key,
                    owner_kind=principal.kind,
                    owner_id=principal.id,
                    job_id=job_id,
                    metric=metric,
                    quantity=quantity,
                    state="reserved",
                    period_kind=kind.value,
                    period_start=start.isoformat(),
                    period_end=end.isoformat(),
                )
                self._store.adjust_reserved(
                    principal.tenant, principal.kind, principal.id, metric, start.isoformat(), quantity
                )
        except sqlite3.IntegrityError:
            # Lost the race on the same idempotency key: the other writer's
            # reservation is the answer.
            existing = self._store.get_usage_event_by_key(
                principal.tenant, principal.kind, principal.id, idempotency_key
            )
            if existing is not None:
                _validate_idempotent_replay(
                    existing,
                    idempotency_key=idempotency_key,
                    metric=metric,
                    quantity=quantity,
                    period_kind=kind.value,
                    period_start=start.isoformat(),
                    period_end=end.isoformat(),
                    job_id=job_id,
                )
                return _reservation_from_row(existing)
            raise
        return UsageReservation(
            id=event_id,
            idempotency_key=idempotency_key,
            metric=metric,
            quantity=quantity,
            state="reserved",
            period_start=start.isoformat(),
            period_end=end.isoformat(),
        )

    def consume(self, reservation_id: uuid.UUID, actual_quantity: int | None = None) -> None:
        """Mark a held reservation consumed (optionally at a corrected
        quantity). Terminal-state events are ignored, so lifecycle callbacks
        may fire twice safely."""
        self._finalize(reservation_id, target="consumed", actual_quantity=actual_quantity)

    def release(self, reservation_id: uuid.UUID, reason: str) -> None:
        """Release a held reservation (service-side failure must not cost
        quota). Same terminal-state tolerance as consume."""
        self._finalize(reservation_id, target="released", metadata={"reason": str(reason)})

    def _finalize(
        self,
        reservation_id: uuid.UUID,
        *,
        target: Literal["consumed", "released"],
        actual_quantity: int | None = None,
        metadata: dict | None = None,
    ) -> None:
        with self._store.transaction():
            row = self._store.get_usage_event(reservation_id)
            if row is None:
                raise SaasError(
                    "USAGE_RESERVATION_NOT_FOUND",
                    f"unknown usage reservation: {reservation_id}",
                    status_code=404,
                )
            if row["state"] != "reserved":
                return
            self._store.update_usage_event(
                reservation_id,
                state=target,
                quantity=actual_quantity,
                metadata=metadata,
            )
            self._store.adjust_reserved(
                row["tenant"], row["owner_kind"], uuid.UUID(row["owner_id"]),
                row["metric"], row["period_start"], -int(row["quantity"]),
            )
