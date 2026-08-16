"""App-side ownership for quota-free PDF rerender request IDs."""
from __future__ import annotations

from app.saas_setup import get_saas_context
from saas.errors import OPERATION_IDEMPOTENCY_CONFLICT, RESOURCE_NOT_FOUND, SaasError
from saas.principals import Principal


PDF_RERENDER_RESOURCE = "pdf_translation_rerender_request"


def record_pdf_rerender_owner(
    principal: Principal,
    request_id: str,
    payload_hash: str,
) -> None:
    """Persist the rerender owner and immutable payload binding before submit."""
    resource_id = str(request_id or "").strip()
    fingerprint = str(payload_hash or "").strip()
    if not resource_id or not fingerprint:
        raise RuntimeError("cannot register a PDF rerender without id and payload hash")
    ctx = get_saas_context()
    claimed = ctx.store.claim_resource_owner(
        ctx.tenant,
        PDF_RERENDER_RESOURCE,
        resource_id,
        principal.kind,
        principal.id,
        fingerprint,
    )
    if claimed:
        return
    if ctx.store.resource_is_owned_by(
        ctx.tenant,
        PDF_RERENDER_RESOURCE,
        resource_id,
        principal.kind,
        principal.id,
    ):
        raise SaasError(
            OPERATION_IDEMPOTENCY_CONFLICT,
            "PDF rerender operation ID was already used for a different payload",
            status_code=409,
        )
    raise SaasError(
        RESOURCE_NOT_FOUND,
        "PDF rerender not found",
        status_code=404,
    )
