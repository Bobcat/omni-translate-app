"""External identity-token verification (JWT).

The control layer trusts no client-supplied identity: a bearer token only
becomes a principal after its signature, expiry, issuer and audience check
out against the configured provider. Asymmetric provider keys are fetched
from the provider's JWKS endpoint (cached by PyJWT's ``PyJWKClient``); an
optional HS256 shared secret covers legacy providers. Nothing here names a
concrete provider — the host wires URL/issuer/audience from its config.
"""
from __future__ import annotations

from typing import Any

import jwt


class ExternalTokenVerifier:
    """Verifies provider-issued JWTs; ``verify`` returns the claims or ``None``.

    ``None`` covers every failure (bad signature, expired, wrong iss/aud,
    unreachable JWKS, malformed token) on purpose: resolution treats an
    unverifiable bearer as absent and falls through to the next step."""

    def __init__(
        self,
        *,
        issuer: str,
        audience: str,
        jwks_url: str | None = None,
        hs256_secret: str | None = None,
        jwks_cache_lifespan_s: float = 3600.0,
    ) -> None:
        self._issuer = str(issuer)
        self._audience = str(audience)
        self._hs256_secret = str(hs256_secret) if hs256_secret else None
        self._jwks_client = (
            jwt.PyJWKClient(jwks_url, cache_keys=True, lifespan=jwks_cache_lifespan_s)
            if jwks_url
            else None
        )

    def verify(self, token: str) -> dict[str, Any] | None:
        text = str(token or "").strip()
        if not text:
            return None
        try:
            algorithm = str(jwt.get_unverified_header(text).get("alg") or "")
            if algorithm == "HS256":
                if self._hs256_secret is None:
                    return None
                key: Any = self._hs256_secret
                algorithms = ["HS256"]
            else:
                if self._jwks_client is None:
                    return None
                key = self._jwks_client.get_signing_key_from_jwt(text).key
                algorithms = ["ES256", "RS256", "EdDSA"]
            claims = jwt.decode(
                text,
                key=key,
                algorithms=algorithms,
                audience=self._audience,
                issuer=self._issuer,
            )
        except Exception:
            # PyJWT errors, JWKS network failures, malformed headers — all the
            # same to the caller: this token vouches for nobody.
            return None
        return claims if isinstance(claims, dict) else None
