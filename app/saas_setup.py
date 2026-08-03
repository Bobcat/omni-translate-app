"""Host wiring for the domain-free ``saas`` package: app config in, router out.

Everything Omni-Translate-specific (config keys, defaults, plan values) lives
here and in ``config/settings.json`` — the package itself stays reusable.
Plans are config-backed for now; the entitlement/quota interfaces are the
stable seam for the later Postgres/Supabase storage.

Non-saas routes (e.g. image translation) resolve the caller's entitlements
through ``resolve_request_entitlements`` — the same anonymous-identity seam
the saas router uses, shared via one process-wide context.
"""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter, Request

from app.config import REPO_ROOT, get_setting, get_str, optional_str
from saas.entitlements import EntitlementService, EntitlementSet
from saas.fastapi_glue import create_saas_router, resolve_request_principal
from saas.principals import Principal, generate_secret
from saas.storage import SaasStore
from saas.tokens import ExternalTokenVerifier
from saas.usage import QuotaService


@dataclass(frozen=True)
class SaasContext:
    store: SaasStore
    entitlement_service: EntitlementService
    quota_service: QuotaService
    signing_secret: str
    tenant: str
    token_verifier: ExternalTokenVerifier | None
    user_plan: str


_context: SaasContext | None = None


def get_saas_context() -> SaasContext:
    """The one process-wide context, shared by the saas router and any app route
    that resolves entitlements. The store connects lazily, so building this is
    side-effect-free (no data/saas.db until a query actually runs)."""
    global _context
    if _context is None:
        _context = _build_context()
    return _context


def _build_context() -> SaasContext:
    tenant = get_str("saas.tenant", "omni-translate")
    db_path = get_str("saas.database_path", "data/saas.db")
    store = SaasStore(REPO_ROOT / db_path)
    plans = {
        str(code): EntitlementService.flatten(values)
        for code, values in dict(get_setting("saas.plans", {}) or {}).items()
    }
    # Without a configured secret the tokens are per-process: fine for local
    # dev (identities are throwaway), set saas.signing_secret in local.json
    # for anything shared.
    signing_secret = optional_str("saas.signing_secret") or generate_secret()
    return SaasContext(
        store=store,
        entitlement_service=EntitlementService(plans),
        quota_service=QuotaService(store),
        signing_secret=signing_secret,
        tenant=tenant,
        token_verifier=_build_token_verifier(),
        user_plan=get_str("saas.auth.user_plan", "free"),
    )


def _build_token_verifier() -> ExternalTokenVerifier | None:
    """The external auth provider's JWT verifier; None until saas.auth.issuer is
    configured (local.json), which keeps every request on the anonymous path."""
    issuer = optional_str("saas.auth.issuer")
    if not issuer:
        return None
    return ExternalTokenVerifier(
        issuer=issuer,
        audience=get_str("saas.auth.audience", "authenticated"),
        jwks_url=optional_str("saas.auth.jwks_url") or f"{issuer.rstrip('/')}/.well-known/jwks.json",
        hs256_secret=optional_str("saas.auth.hs256_secret"),
    )


def build_saas_router() -> APIRouter:
    ctx = get_saas_context()
    return create_saas_router(
        store=ctx.store,
        entitlement_service=ctx.entitlement_service,
        quota_service=ctx.quota_service,
        signing_secret=ctx.signing_secret,
        tenant=ctx.tenant,
        user_plan=ctx.user_plan,
        token_verifier=ctx.token_verifier,
        usage_metrics=list(get_setting("saas.usage_metrics", []) or []),
    )


def resolve_request_context(request: Request) -> tuple[Principal, EntitlementSet, str | None]:
    """The caller's principal and resolved entitlements, plus the fresh identity
    token when an anonymous identity was just provisioned (None for bearer-auth
    users and valid cookies). The route attaches the token to ITS response via
    ``set_identity_cookie`` (a raw-``Response`` route has no injected response
    param to set cookies on)."""
    ctx = get_saas_context()
    principal, token = resolve_request_principal(
        request,
        store=ctx.store,
        signing_secret=ctx.signing_secret,
        tenant=ctx.tenant,
        user_plan=ctx.user_plan,
        token_verifier=ctx.token_verifier,
    )
    return principal, ctx.entitlement_service.resolve(principal), token


def resolve_request_entitlements(request: Request) -> tuple[EntitlementSet, str | None]:
    """The caller's resolved entitlements plus identity token — the
    ``resolve_request_context`` shape for routes that never touch the
    principal itself (e.g. a per-job ceiling without quota accounting)."""
    _, entitlements, token = resolve_request_context(request)
    return entitlements, token
