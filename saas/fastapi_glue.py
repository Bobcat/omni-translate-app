"""FastAPI glue for the saas package — the only FastAPI-aware module.

Keeps the core framework-free so the package stays extractable. Sync ``def``
routes on purpose (same threadpool pattern as the app's other routes): the
store is sync sqlite.

Resolution order (brief §7): a verified Supabase bearer resolves a user;
otherwise the signed anonymous-cookie path applies.
"""
from __future__ import annotations

import math
from typing import Any, Mapping

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from saas.entitlements import EntitlementService
from saas.errors import SaasError
from saas.principals import Principal, sign_identity, verify_identity_token
from saas.storage import SaasStore
from saas.tokens import ExternalTokenVerifier
from saas.usage import QuotaService


def saas_error_handler(_request: Request, exc: SaasError) -> JSONResponse:
    headers = None
    retry_after = exc.details.get("retry_after_s")
    if exc.status_code == 429 and isinstance(retry_after, (int, float)):
        headers = {"Retry-After": str(max(1, math.ceil(retry_after)))}
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
        headers=headers,
    )


DEFAULT_COOKIE_NAME = "ot_anon"
DEFAULT_COOKIE_MAX_AGE_S = 180 * 24 * 3600
_PENDING_IDENTITY_COOKIE = "saas_pending_identity_cookie"


def _request_is_https(request: Request) -> bool:
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    return forwarded == "https" or request.url.scheme == "https"


def resolve_anonymous_identity(
    request: Request,
    *,
    store: SaasStore,
    signing_secret: str,
    tenant: str,
    anonymous_plan: str = "anonymous",
    cookie_name: str = DEFAULT_COOKIE_NAME,
) -> tuple[Principal, str | None]:
    """Signed anonymous cookie → existing principal; otherwise create a fresh
    identity and return its token. The id never leaves the server unsigned.

    The token is returned so the host can stage it for response middleware;
    this also puts the cookie on controlled error responses."""
    token = request.cookies.get(cookie_name, "")
    identity_id = verify_identity_token(token, signing_secret) if token else None
    if identity_id is not None:
        row = store.get_identity(tenant, identity_id)
        if row is not None and row["status"] == "active":
            return Principal(tenant=tenant, kind="anonymous", id=identity_id, plan_code=anonymous_plan), None
    identity_id = store.create_identity(tenant)
    return (
        Principal(tenant=tenant, kind="anonymous", id=identity_id, plan_code=anonymous_plan),
        sign_identity(identity_id, signing_secret),
    )


def resolve_request_principal(
    request: Request,
    *,
    store: SaasStore,
    signing_secret: str,
    tenant: str,
    anonymous_plan: str = "anonymous",
    user_plan: str = "free",
    token_verifier: ExternalTokenVerifier | None = None,
    cookie_name: str = DEFAULT_COOKIE_NAME,
) -> tuple[Principal, str | None]:
    """Resolution order (brief §7): a valid bearer token → user principal; else the
    signed anonymous cookie; else a fresh anonymous identity (its token returned for
    the caller to set). An UNVERIFIABLE bearer falls through to anonymous — the
    client notices the plan drop via /api/me and re-authenticates."""
    if token_verifier is not None:
        subject = _bearer_subject(request, token_verifier)
        if subject is not None:
            identity_id = store.get_or_create_external_identity(tenant, subject)
            return Principal(tenant=tenant, kind="user", id=identity_id, plan_code=user_plan), None
    return resolve_anonymous_identity(
        request,
        store=store,
        signing_secret=signing_secret,
        tenant=tenant,
        anonymous_plan=anonymous_plan,
        cookie_name=cookie_name,
    )


def _bearer_subject(request: Request, verifier: ExternalTokenVerifier) -> str | None:
    header = request.headers.get("authorization") or ""
    scheme, _, token = header.partition(" ")
    if scheme.strip().lower() != "bearer" or not token.strip():
        return None
    claims = verifier.verify(token.strip())
    subject = str(claims.get("sub") or "").strip() if claims else ""
    return subject or None


def set_identity_cookie(
    request: Request,
    response: Response,
    token: str,
    *,
    cookie_name: str = DEFAULT_COOKIE_NAME,
    cookie_max_age_s: int = DEFAULT_COOKIE_MAX_AGE_S,
) -> None:
    response.set_cookie(
        cookie_name,
        token,
        max_age=cookie_max_age_s,
        httponly=True,
        samesite="lax",
        # Secure cookies are rejected by browsers on plain http; only mark
        # secure when this request actually arrived over https (incl. via
        # the Cloudflare proxy).
        secure=_request_is_https(request),
    )


def stage_identity_cookie(
    request: Request,
    token: str,
    *,
    cookie_name: str = DEFAULT_COOKIE_NAME,
    cookie_max_age_s: int = DEFAULT_COOKIE_MAX_AGE_S,
) -> None:
    """Remember a newly issued identity token until the final response exists.

    Routes may fail after principal resolution. Staging the cookie on the
    request lets the host middleware attach it to successful and controlled
    error responses alike, so rejected first requests reuse one identity.
    """
    setattr(
        request.state,
        _PENDING_IDENTITY_COOKIE,
        (str(token), str(cookie_name), int(cookie_max_age_s)),
    )


def apply_staged_identity_cookie(request: Request, response: Response) -> None:
    pending = getattr(request.state, _PENDING_IDENTITY_COOKIE, None)
    if pending is None:
        return
    token, cookie_name, cookie_max_age_s = pending
    set_identity_cookie(
        request,
        response,
        token,
        cookie_name=cookie_name,
        cookie_max_age_s=cookie_max_age_s,
    )


async def identity_cookie_middleware(request: Request, call_next) -> Response:
    response = await call_next(request)
    apply_staged_identity_cookie(request, response)
    return response


def create_saas_router(
    *,
    store: SaasStore,
    entitlement_service: EntitlementService,
    quota_service: QuotaService,
    signing_secret: str,
    tenant: str,
    anonymous_plan: str = "anonymous",
    user_plan: str = "free",
    token_verifier: ExternalTokenVerifier | None = None,
    usage_metrics: list[Mapping[str, Any]] | None = None,
    cookie_name: str = DEFAULT_COOKIE_NAME,
    cookie_max_age_s: int = DEFAULT_COOKIE_MAX_AGE_S,
) -> APIRouter:
    router = APIRouter(prefix="/api")

    def resolve_principal(request: Request) -> Principal:
        principal, token = resolve_request_principal(
            request,
            store=store,
            signing_secret=signing_secret,
            tenant=tenant,
            anonymous_plan=anonymous_plan,
            user_plan=user_plan,
            token_verifier=token_verifier,
            cookie_name=cookie_name,
        )
        if token is not None:
            stage_identity_cookie(
                request,
                token,
                cookie_name=cookie_name,
                cookie_max_age_s=cookie_max_age_s,
            )
        return principal

    # Sync def: store is sync sqlite — let FastAPI use the threadpool.
    @router.get("/me")
    def get_me(request: Request) -> dict[str, Any]:
        principal = resolve_principal(request)
        return {"principal": {"kind": principal.kind, "plan": principal.plan_code}}

    @router.get("/entitlements")
    def get_entitlements(request: Request) -> dict[str, Any]:
        principal = resolve_principal(request)
        entitlements = entitlement_service.resolve(principal)
        return {"plan": entitlements.plan_code, "entitlements": entitlements.snapshot()}

    @router.get("/usage")
    def get_usage_endpoint(request: Request) -> dict[str, Any]:
        principal = resolve_principal(request)
        entitlements = entitlement_service.resolve(principal)
        usage = []
        for spec in usage_metrics or []:
            period_key = str(spec.get("period_key") or "")
            period = (
                entitlements.get_str(period_key)
                if period_key
                else str(spec.get("period") or "month")
            )
            summary = quota_service.get_usage(
                principal, str(spec["metric"]), period
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
                    "remaining": max(0, limit - summary.reserved - summary.consumed)
                    if limit is not None
                    else None,
                }
            )
        return {"usage": usage}

    return router
