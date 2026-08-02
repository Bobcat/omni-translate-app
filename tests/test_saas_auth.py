"""External auth (phase 5a): bearer-JWT verification and the user-principal
resolution order — a valid bearer wins over the anonymous cookie, an
unverifiable bearer falls through to anonymous."""
from __future__ import annotations

import json
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives.asymmetric.ec import SECP256R1, generate_private_key
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat
from fastapi import FastAPI
from fastapi.testclient import TestClient

from saas.entitlements import EntitlementService
from saas.errors import SaasError
from saas.fastapi_glue import create_saas_router, saas_error_handler
from saas.storage import SaasStore
from saas.tokens import ExternalTokenVerifier
from saas.usage import QuotaService

SECRET = "auth-test-secret"
ISSUER = "https://project-ref.supabase.co/auth/v1"
KID = "test-key-1"

_PRIVATE_KEY = generate_private_key(SECP256R1())
_PRIVATE_PEM = _PRIVATE_KEY.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
_PUBLIC_JWK = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(_PRIVATE_KEY.public_key()))
_PUBLIC_JWK.update({"kid": KID, "use": "sig", "alg": "ES256"})
JWKS = {"keys": [_PUBLIC_JWK]}


def _make_token(**overrides: object) -> str:
    now = int(time.time())
    payload = {
        "sub": "user-abc-123",
        "aud": "authenticated",
        "iss": ISSUER,
        "iat": now,
        "exp": now + 3600,
    }
    payload.update(overrides)
    return jwt.encode(payload, _PRIVATE_PEM, algorithm="ES256", headers={"kid": KID})


def _jwks_verifier(**overrides: object) -> ExternalTokenVerifier:
    kwargs = {"issuer": ISSUER, "audience": "authenticated", "jwks_url": f"{ISSUER}/.well-known/jwks.json"}
    kwargs.update(overrides)
    return ExternalTokenVerifier(**kwargs)


def _make_app(db_path: Path, *, with_verifier: bool = True) -> FastAPI:
    store = SaasStore(db_path)
    plans = {
        "anonymous": EntitlementService.flatten({"image_translation": {"enabled": True}}),
        "free": EntitlementService.flatten({"pdf_translation": {"enabled": True}}),
    }
    app = FastAPI()
    app.include_router(
        create_saas_router(
            store=store,
            entitlement_service=EntitlementService(plans),
            quota_service=QuotaService(store),
            signing_secret=SECRET,
            tenant="test",
            token_verifier=_jwks_verifier() if with_verifier else None,
        )
    )
    app.add_exception_handler(SaasError, saas_error_handler)
    return app


class ExternalTokenVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        # PyJWKClient fetches the provider's JWKS over HTTP; serve ours from memory.
        patcher = patch.object(jwt.PyJWKClient, "fetch_data", lambda self: JWKS)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_valid_token_yields_claims(self) -> None:
        claims = _jwks_verifier().verify(_make_token())
        self.assertIsNotNone(claims)
        self.assertEqual(claims["sub"], "user-abc-123")

    def test_expired_token_is_rejected(self) -> None:
        now = int(time.time())
        token = _make_token(iat=now - 7200, exp=now - 3600)
        self.assertIsNone(_jwks_verifier().verify(token))

    def test_wrong_audience_is_rejected(self) -> None:
        self.assertIsNone(_jwks_verifier().verify(_make_token(aud="service_role")))

    def test_wrong_issuer_is_rejected(self) -> None:
        self.assertIsNone(_jwks_verifier().verify(_make_token(iss="https://evil.example")))

    def test_garbage_is_rejected(self) -> None:
        self.assertIsNone(_jwks_verifier().verify("not-a-jwt"))

    def test_hs256_roundtrip_only_with_a_configured_secret(self) -> None:
        token = jwt.encode(
            {"sub": "legacy-user", "aud": "authenticated", "iss": ISSUER, "exp": int(time.time()) + 3600},
            "legacy-secret",
            algorithm="HS256",
        )
        with_secret = _jwks_verifier(hs256_secret="legacy-secret")
        self.assertEqual(with_secret.verify(token)["sub"], "legacy-user")
        self.assertIsNone(_jwks_verifier().verify(token))


class ExternalIdentityStoreTests(unittest.TestCase):
    def test_external_subject_maps_to_one_stable_identity(self) -> None:
        with TemporaryDirectory() as tmp:
            store = SaasStore(Path(tmp) / "saas.db")
            first = store.get_or_create_external_identity("test", "user-abc-123")
            second = store.get_or_create_external_identity("test", "user-abc-123")
            other = store.get_or_create_external_identity("test", "user-xyz-789")
            anonymous = store.create_identity("test")
            row = store.get_identity("test", first)
        self.assertEqual(first, second)
        self.assertNotEqual(first, other)
        self.assertNotEqual(first, anonymous)
        self.assertEqual(row["kind"], "user")
        self.assertEqual(row["external_subject"], "user-abc-123")

    def test_pre_user_database_is_migrated_with_rows_intact(self) -> None:
        import sqlite3
        import uuid as uuid_mod

        legacy_id = str(uuid_mod.uuid4())
        with TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "saas.db"
            legacy = sqlite3.connect(db_path)
            legacy.execute(
                "CREATE TABLE anonymous_identities (tenant TEXT NOT NULL, id TEXT PRIMARY KEY,"
                " created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT,"
                " status TEXT NOT NULL DEFAULT 'active')"
            )
            legacy.execute(
                "INSERT INTO anonymous_identities (tenant, id, created_at, last_seen_at, status)"
                " VALUES ('test', ?, 'now', 'now', 'active')",
                (legacy_id,),
            )
            legacy.commit()
            legacy.close()

            store = SaasStore(db_path)
            carried = store.get_identity("test", uuid_mod.UUID(legacy_id))
            store.get_or_create_external_identity("test", "user-abc-123")
        self.assertIsNotNone(carried)
        self.assertEqual(carried["kind"], "anonymous")


class BearerResolutionRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        patcher = patch.object(jwt.PyJWKClient, "fetch_data", lambda self: JWKS)
        patcher.start()
        self.addCleanup(patcher.stop)
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.client = TestClient(_make_app(Path(self._tmp.name) / "saas.db"))

    def test_valid_bearer_resolves_the_user_plan(self) -> None:
        response = self.client.get("/api/me", headers={"Authorization": f"Bearer {_make_token()}"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"principal": {"kind": "user", "plan": "free"}})
        self.assertNotIn("set-cookie", response.headers)

    def test_bearer_wins_over_the_anonymous_cookie(self) -> None:
        anonymous = self.client.get("/api/me")
        self.assertEqual(anonymous.json()["principal"]["kind"], "anonymous")
        response = self.client.get("/api/me", headers={"Authorization": f"Bearer {_make_token()}"})
        self.assertEqual(response.json()["principal"]["kind"], "user")

    def test_unverifiable_bearer_falls_through_to_anonymous(self) -> None:
        forged = _make_token()[:-2] + "xx"
        response = self.client.get("/api/me", headers={"Authorization": f"Bearer {forged}"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["principal"]["kind"], "anonymous")
        self.assertIn("set-cookie", response.headers)

    def test_bearer_is_ignored_without_a_configured_verifier(self) -> None:
        with TemporaryDirectory() as tmp:
            client = TestClient(_make_app(Path(tmp) / "saas.db", with_verifier=False))
            response = client.get("/api/me", headers={"Authorization": f"Bearer {_make_token()}"})
        self.assertEqual(response.json()["principal"]["kind"], "anonymous")


if __name__ == "__main__":
    unittest.main()
