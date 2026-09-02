"""Host wiring for the domain-free ``saas`` package: app config in, router out.

Everything Omni-Translate-specific (config keys, defaults, plan values) lives
here and in ``config/settings.json`` — the package itself stays reusable.
Plans are config-backed for now; the entitlement/quota interfaces are the
stable seam for the later Postgres/Supabase storage.

Non-saas routes resolve the caller through ``resolve_request_context`` (or its
entitlement-only wrapper) — the same anonymous-identity seam the saas router
uses, shared via one process-wide context.
"""
from __future__ import annotations

import hashlib
import os
import uuid
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Request

from app.config import REPO_ROOT, get_setting, get_str, optional_str
from app.credits.policy import CreditCostPolicy
from app.credits.quotes import CreditQuoteService
from saas.entitlements import EntitlementService, EntitlementSet
from saas.fastapi_glue import (
    create_saas_router,
    resolve_request_principal,
    stage_identity_cookie,
)
from saas.principals import Principal, generate_secret, sign_identity
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
    credit_policy: CreditCostPolicy | None = None
    credit_quote_service: CreditQuoteService | None = None


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
    plan_assignments = {
        str(principal_id): str(plan_code)
        for principal_id, plan_code in dict(
            get_setting("saas.plan_assignments", {}) or {}
        ).items()
    }
    signing_secret = optional_str("saas.signing_secret") or _load_or_create_signing_secret(
        REPO_ROOT / get_str("saas.signing_secret_path", "data/saas-signing.key")
    )
    quota_service = QuotaService(store)
    credit_policy = CreditCostPolicy.from_config(
        config=dict(get_setting("saas.credit_costs", {}) or {}),
    )
    return SaasContext(
        store=store,
        entitlement_service=EntitlementService(plans, plan_assignments),
        quota_service=quota_service,
        signing_secret=signing_secret,
        tenant=tenant,
        token_verifier=_build_token_verifier(),
        user_plan=get_str("saas.auth.user_plan", "free"),
        credit_policy=credit_policy,
        credit_quote_service=CreditQuoteService(
            store=store,
            quota_service=quota_service,
            policy=credit_policy,
        ),
    )


def _load_or_create_signing_secret(path: Path) -> str:
    """Return one host-persistent secret, safe under concurrent first starts."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        secret = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        candidate = generate_secret()
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(candidate)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        finally:
            temporary.unlink(missing_ok=True)
        secret = path.read_text(encoding="utf-8").strip()
    if not secret:
        raise RuntimeError(f"empty SaaS signing secret: {path}")
    path.chmod(0o600)
    return secret


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
    users and valid cookies). A fresh token is staged for the response middleware
    so controlled errors receive the cookie too."""
    ctx = get_saas_context()
    principal, token = resolve_request_principal(
        request,
        store=ctx.store,
        signing_secret=ctx.signing_secret,
        tenant=ctx.tenant,
        user_plan=ctx.user_plan,
        token_verifier=ctx.token_verifier,
    )
    if token is not None:
        stage_identity_cookie(request, token)
    return principal, ctx.entitlement_service.resolve(principal), token


def resolve_request_entitlements(request: Request) -> tuple[EntitlementSet, str | None]:
    """The caller's resolved entitlements plus identity token — the
    ``resolve_request_context`` shape for routes that never touch the
    principal itself (e.g. a per-job ceiling without quota accounting)."""
    _, entitlements, token = resolve_request_context(request)
    return entitlements, token


def stage_fresh_anonymous_identity(request: Request) -> None:
    """Replace the browser's anonymous identity on the final response."""
    ctx = get_saas_context()
    identity_id = ctx.store.create_identity(ctx.tenant)
    stage_identity_cookie(request, sign_identity(identity_id, ctx.signing_secret))


def tts_fairness_key_for_principal(principal: Principal) -> str:
    """Return the stable opaque scheduler identity trusted by TTS-pool."""
    source = f"{principal.tenant}:{principal.kind}:{principal.id}".encode("utf-8")
    return f"principal_{hashlib.sha256(source).hexdigest()[:32]}"
