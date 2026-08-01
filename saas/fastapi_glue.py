"""FastAPI glue for the saas package — the only FastAPI-aware module.

Keeps the core framework-free so the package stays extractable. Sync ``def``
routes on purpose (same threadpool pattern as the app's other routes): the
store is sync sqlite.

Resolution order (brief §7) is implemented for the anonymous branch only —
the Supabase user branch slots in ahead of it in phase 5 without touching
the routes.
"""
from __future__ import annotations

from typing import Any, Mapping

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from saas.entitlements import EntitlementService
from saas.errors import SaasError
from saas.principals import Principal, sign_identity, verify_identity_token
from saas.storage import SaasStore
from saas.usage import QuotaService


def saas_error_handler(_request: Request, exc: SaasError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
    )


def _request_is_https(request: Request) -> bool:
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    return forwarded == "https" or request.url.scheme == "https"


def create_saas_router(
    *,
    store: SaasStore,
    entitlement_service: EntitlementService,
    quota_service: QuotaService,
    signing_secret: str,
    tenant: str,
    anonymous_plan: str = "anonymous",
    usage_metrics: list[Mapping[str, Any]] | None = None,
    cookie_name: str = "ot_anon",
    cookie_max_age_s: int = 180 * 24 * 3600,
) -> APIRouter:
    router = APIRouter(prefix="/api")

    def resolve_principal(request: Request, response: Response) -> Principal:
        """Signed anonymous cookie → existing principal; otherwise create a
        fresh identity and issue its token. The id never leaves the server
        unsigned."""
        token = request.cookies.get(cookie_name, "")
        identity_id = verify_identity_token(token, signing_secret) if token else None
        if identity_id is not None:
            row = store.get_identity(tenant, identity_id)
            if row is not None and row["status"] == "active":
                return Principal(tenant=tenant, kind="anonymous", id=identity_id, plan_code=anonymous_plan)
        identity_id = store.create_identity(tenant)
        response.set_cookie(
            cookie_name,
            sign_identity(identity_id, signing_secret),
            max_age=cookie_max_age_s,
            httponly=True,
            samesite="lax",
            # Secure cookies are rejected by browsers on plain http; only mark
            # secure when this request actually arrived over https (incl. via
            # the Cloudflare proxy).
            secure=_request_is_https(request),
        )
        return Principal(tenant=tenant, kind="anonymous", id=identity_id, plan_code=anonymous_plan)

    # Sync def: store is sync sqlite — let FastAPI use the threadpool.
    @router.get("/me")
    def get_me(request: Request, response: Response) -> dict[str, Any]:
        principal = resolve_principal(request, response)
        return {"principal": {"kind": principal.kind, "plan": principal.plan_code}}

    @router.get("/entitlements")
    def get_entitlements(request: Request, response: Response) -> dict[str, Any]:
        principal = resolve_principal(request, response)
        entitlements = entitlement_service.resolve(principal)
        return {"plan": entitlements.plan_code, "entitlements": entitlements.snapshot()}

    @router.get("/usage")
    def get_usage_endpoint(request: Request, response: Response) -> dict[str, Any]:
        principal = resolve_principal(request, response)
        entitlements = entitlement_service.resolve(principal)
        usage = []
        for spec in usage_metrics or []:
            summary = quota_service.get_usage(
                principal, str(spec["metric"]), str(spec.get("period") or "month")
            )
            limit_key = str(spec.get("limit_key") or "")
            limit = entitlements.get_int(limit_key) if limit_key and entitlements.has(limit_key) else None
            usage.append(
                {
                    "metric": summary.metric,
                    "period": summary.period_kind,
                    "period_start": summary.period_start,
                    "period_end": summary.period_end,
                    "reserved": summary.reserved,
                    "consumed": summary.consumed,
                    "limit": limit,
                    "remaining": (limit - summary.reserved - summary.consumed) if limit is not None else None,
                }
            )
        return {"usage": usage}

    return router
