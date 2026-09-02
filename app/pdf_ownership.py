"""App-side ownership for staged PDF credit request IDs."""
from __future__ import annotations

from app.saas_setup import get_saas_context
from saas.errors import OPERATION_IDEMPOTENCY_CONFLICT, RESOURCE_NOT_FOUND, SaasError
from saas.principals import Principal


PDF_CREDIT_RESOURCE = "pdf_translation_credit_request"


def record_pdf_credit_owner(
    principal: Principal,
    request_id: str,
    payload_hash: str,
) -> None:
    resource_id = str(request_id or "").strip()
    fingerprint = str(payload_hash or "").strip()
    if not resource_id or not fingerprint:
        raise RuntimeError("cannot register a PDF translation without id and payload hash")
    ctx = get_saas_context()
    claimed = ctx.store.claim_resource_owner(
        ctx.tenant,
        PDF_CREDIT_RESOURCE,
        resource_id,
        principal.kind,
        principal.id,
        fingerprint,
    )
    if claimed:
        return
    if ctx.store.resource_is_owned_by(
        ctx.tenant,
        PDF_CREDIT_RESOURCE,
        resource_id,
        principal.kind,
        principal.id,
    ):
        raise SaasError(
            OPERATION_IDEMPOTENCY_CONFLICT,
            "PDF translation operation ID was already used for a different payload",
            status_code=409,
        )
    raise SaasError(
        RESOURCE_NOT_FOUND,
        "PDF translation not found",
        status_code=404,
    )
