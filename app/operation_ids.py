"""Validation for caller-supplied operation IDs shared by app workflows."""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Mapping

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


def operation_payload_hash(
    operation_kind: str,
    *,
    parameters: Mapping[str, str],
    content: bytes | None = None,
) -> str:
    """Stable app-side binding between one operation ID and its workflow inputs."""
    payload = {
        "operation_kind": str(operation_kind),
        "parameters": {str(key): str(value) for key, value in parameters.items()},
    }
    if content is not None:
        payload["content_sha256"] = hashlib.sha256(content).hexdigest()
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
