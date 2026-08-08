"""App-side ownership for translation-services image request IDs."""
from __future__ import annotations

from app.saas_setup import get_saas_context
from saas.errors import OPERATION_IDEMPOTENCY_CONFLICT, RESOURCE_NOT_FOUND, SaasError
from saas.principals import Principal

IMAGE_REQUEST_RESOURCE = "image_translation_request"


def record_image_request_owner(
    principal: Principal,
    request_id: str,
    payload_hash: str,
) -> None:
    """Persist the owner and immutable payload binding before upstream submit."""
    resource_id = str(request_id or "").strip()
    fingerprint = str(payload_hash or "").strip()
    if not resource_id or not fingerprint:
        raise RuntimeError("cannot register an image operation without id and payload hash")
    ctx = get_saas_context()
    claimed = ctx.store.claim_resource_owner(
        ctx.tenant,
        IMAGE_REQUEST_RESOURCE,
        resource_id,
        principal.kind,
        principal.id,
        fingerprint,
    )
    if claimed:
        return
    if ctx.store.resource_is_owned_by(
        ctx.tenant,
        IMAGE_REQUEST_RESOURCE,
        resource_id,
        principal.kind,
        principal.id,
    ):
        raise SaasError(
            OPERATION_IDEMPOTENCY_CONFLICT,
            "image operation ID was already used for a different payload",
            status_code=409,
        )
    raise SaasError(
        RESOURCE_NOT_FOUND,
        "image operation not found",
        status_code=404,
    )


def require_image_request_owner(principal: Principal, request_id: str) -> None:
    """Hide unknown and other-owner image requests behind the same 404."""
    ctx = get_saas_context()
    owned = ctx.store.resource_is_owned_by(
        ctx.tenant,
        IMAGE_REQUEST_RESOURCE,
        str(request_id),
        principal.kind,
        principal.id,
    )
    if not owned:
        raise SaasError(
            RESOURCE_NOT_FOUND,
            "image request not found",
            status_code=404,
        )
