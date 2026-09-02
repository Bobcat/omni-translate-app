"""Stable machine-readable error codes for the control layer.

The HTTP mapping lives in the FastAPI glue; the core only carries the code.
Codes follow the brief's error model (plan/saas-foundation-entitlements.md
§15) so clients can switch on them reliably.
"""
from __future__ import annotations

# A feature the principal's plan does not include.
ENTITLEMENT_DISABLED = "ENTITLEMENT_DISABLED"
# A required entitlement key is absent entirely (server misconfiguration —
# fails closed, never silently allowed).
ENTITLEMENT_UNKNOWN = "ENTITLEMENT_UNKNOWN"
# The reservation would exceed the period allowance.
PERIOD_QUOTA_EXCEEDED = "PERIOD_QUOTA_EXCEEDED"
# A credit reservation would exceed the available credit grant.
CREDITS_EXHAUSTED = "CREDITS_EXHAUSTED"
# A binding quote reached its expiry before it was confirmed.
QUOTE_EXPIRED = "QUOTE_EXPIRED"
# A quote was reused with another owner, action, payload, or operation.
QUOTE_MISMATCH = "QUOTE_MISMATCH"
# An operational request-rate or in-flight limit has been reached.
RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED"
# An idempotency key was replayed with different reservation inputs.
USAGE_IDEMPOTENCY_CONFLICT = "USAGE_IDEMPOTENCY_CONFLICT"
# An operation ID was replayed with a different workflow payload.
OPERATION_IDEMPOTENCY_CONFLICT = "OPERATION_IDEMPOTENCY_CONFLICT"
# A caller-supplied operation id is absent or is not a random UUID.
INVALID_OPERATION_ID = "INVALID_OPERATION_ID"
# The upload cannot be parsed or fails basic validation.
INVALID_UPLOAD = "INVALID_UPLOAD"
# The upload's declared media type is not accepted by this workflow.
UNSUPPORTED_MEDIA_TYPE = "UNSUPPORTED_MEDIA_TYPE"
# The upload exceeds the plan's per-job cap.
PAGE_LIMIT_PER_JOB_EXCEEDED = "PAGE_LIMIT_PER_JOB_EXCEEDED"
# An owned host resource is absent or deliberately hidden from this principal.
RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND"


class SaasError(Exception):
    """A control-layer failure with a stable machine-readable code."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 400,
        details: dict | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = dict(details or {})
