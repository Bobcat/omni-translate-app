"""Validation for caller-supplied operation IDs shared by app workflows."""
from __future__ import annotations

import uuid

from saas.errors import INVALID_OPERATION_ID, SaasError


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
