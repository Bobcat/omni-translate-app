"""Host wiring for the domain-free ``saas`` package: app config in, router out.

Everything Omni-Translate-specific (config keys, defaults, plan values) lives
here and in ``config/settings.json`` — the package itself stays reusable.
Plans are config-backed for now; the entitlement/quota interfaces are the
stable seam for the later Postgres/Supabase storage.
"""
from __future__ import annotations

from fastapi import APIRouter

from app.config import REPO_ROOT, get_setting, get_str, optional_str
from saas.entitlements import EntitlementService
from saas.fastapi_glue import create_saas_router
from saas.principals import generate_secret
from saas.storage import SaasStore
from saas.usage import QuotaService


def build_saas_router() -> APIRouter:
    tenant = get_str("saas.tenant", "omni-translate")
    db_path = get_str("saas.database_path", "data/saas.db")
    store = SaasStore(REPO_ROOT / db_path)
    plans = {
        str(code): EntitlementService.flatten(values)
        for code, values in dict(get_setting("saas.plans", {}) or {}).items()
    }
    entitlement_service = EntitlementService(plans)
    quota_service = QuotaService(store)
    # Without a configured secret the tokens are per-process: fine for local
    # dev (identities are throwaway), set saas.signing_secret in local.json
    # for anything shared.
    signing_secret = optional_str("saas.signing_secret") or generate_secret()
    return create_saas_router(
        store=store,
        entitlement_service=entitlement_service,
        quota_service=quota_service,
        signing_secret=signing_secret,
        tenant=tenant,
        usage_metrics=list(get_setting("saas.usage_metrics", []) or []),
    )
