"""Voice-library write routes are gated on the plan's curation capability.

The stable samples in data/voice_library/stable are shared state: keeping a
pending sample overwrites the reference voice every session in that language
uses. Reads stay public because the browser plays them and the TTS bridge
reads the WAV straight from disk.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.saas_setup import SaasContext, require_voice_library_curation
from saas.entitlements import EntitlementService
from saas.errors import ENTITLEMENT_DISABLED, SaasError
from saas.principals import Principal
from saas.storage import SaasStore
from saas.usage import QuotaService

TENANT = "test"
OPERATOR_SUB = "operator-sub"
LANGUAGE = "en"
GENDER = "female"

_PLAN_CONFIG = {
    "anonymous": {"compute": {"credits_per_period": 300}},
    "free": {"compute": {"credits_per_period": 3000}},
    "developer": {
        "compute": {"credits_per_period": 1000000},
        "voice_library": {"curate": True},
    },
}
PLANS = {code: EntitlementService.flatten(values) for code, values in _PLAN_CONFIG.items()}


class _StubVerifier:
    """Stands in for the Supabase JWKS verifier; the behaviour under test is the
    entitlement check, not token verification."""

    def verify(self, token: str):
        if token == "operator-token":
            return {"sub": OPERATOR_SUB}
        return None


class VoiceLibraryRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.store = SaasStore(Path(self._tmp.name) / "saas.db")
        operator_identity = self.store.get_or_create_external_identity(TENANT, OPERATOR_SUB)
        self.ctx = SaasContext(
            store=self.store,
            entitlement_service=EntitlementService(PLANS, {str(operator_identity): "developer"}),
            quota_service=QuotaService(self.store),
            signing_secret="voice-library-test-secret",
            tenant=TENANT,
            token_verifier=_StubVerifier(),
            user_plan="free",
        )
        self._context_patch = patch("app.saas_setup.get_saas_context", return_value=self.ctx)
        self._context_patch.start()
        # No context manager on purpose: lifespan (ASR warmup) must not run.
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self._context_patch.stop()
        self.store.close()
        self._tmp.cleanup()

    def _operator_headers(self) -> dict[str, str]:
        return {"Authorization": "Bearer operator-token"}

    def test_generate_is_refused_for_anonymous_callers(self) -> None:
        response = self.client.post(
            "/api/voice-library/stable",
            json={"language": LANGUAGE, "gender": GENDER, "engine": "voxcpm2"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], ENTITLEMENT_DISABLED)
        self.assertEqual(
            response.json()["error"]["details"]["entitlement"], "voice_library.curate"
        )

    def test_keep_and_discard_are_refused_for_anonymous_callers(self) -> None:
        for action in ("keep-pending", "discard-pending"):
            with self.subTest(action=action):
                response = self.client.post(
                    f"/api/voice-library/stable/{LANGUAGE}/{GENDER}/{action}"
                )
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["error"]["code"], ENTITLEMENT_DISABLED)

    def test_generate_is_reachable_for_the_curation_plan(self) -> None:
        with patch("app.router.generate_stable_sample", return_value={"status": "pending"}) as generate:
            response = self.client.post(
                "/api/voice-library/stable",
                json={"language": LANGUAGE, "gender": GENDER, "engine": "voxcpm2"},
                headers=self._operator_headers(),
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["info"], {"status": "pending"})
        self.assertEqual(generate.call_count, 1)

    def test_keep_and_discard_are_reachable_for_the_curation_plan(self) -> None:
        with patch("app.router.keep_pending_stable_sample", return_value={"status": "kept"}) as keep:
            response = self.client.post(
                f"/api/voice-library/stable/{LANGUAGE}/{GENDER}/keep-pending",
                headers=self._operator_headers(),
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(keep.call_count, 1)

        with patch("app.router.discard_pending_stable_sample", return_value={"status": "discarded"}) as discard:
            response = self.client.post(
                f"/api/voice-library/stable/{LANGUAGE}/{GENDER}/discard-pending",
                headers=self._operator_headers(),
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(discard.call_count, 1)

    def test_public_reads_still_answer_for_anonymous_callers(self) -> None:
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)


class VoiceLibraryCurationGuardTests(unittest.TestCase):
    """The guard itself, exercised without the ASR-heavy app import."""

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.store = SaasStore(Path(self._tmp.name) / "saas.db")
        self.ctx = SaasContext(
            store=self.store,
            entitlement_service=EntitlementService(PLANS),
            quota_service=QuotaService(self.store),
            signing_secret="voice-library-test-secret",
            tenant=TENANT,
            token_verifier=_StubVerifier(),
            user_plan="free",
        )
        self._context_patch = patch("app.saas_setup.get_saas_context", return_value=self.ctx)
        self._context_patch.start()

    def tearDown(self) -> None:
        self._context_patch.stop()
        self.store.close()
        self._tmp.cleanup()

    @staticmethod
    def _request(headers: dict[str, str] | None = None):
        from starlette.requests import Request

        raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
        return Request({"type": "http", "method": "POST", "path": "/", "headers": raw})

    def test_anonymous_caller_is_refused(self) -> None:
        with self.assertRaises(SaasError) as caught:
            require_voice_library_curation(self._request())
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(caught.exception.code, ENTITLEMENT_DISABLED)

    def test_authenticated_non_operator_is_refused_and_operator_is_allowed(self) -> None:
        identity_id = self.store.get_or_create_external_identity(TENANT, OPERATOR_SUB)
        principal = Principal(tenant=TENANT, kind="user", id=identity_id, plan_code="free")
        # The plan assignment is what grants curation; the plan name alone is not.
        self.assertFalse(self.ctx.entitlement_service.resolve(principal).is_enabled("voice_library.curate"))
        assigned = EntitlementService(PLANS, {str(identity_id): "developer"}).resolve(principal)
        self.assertTrue(assigned.is_enabled("voice_library.curate"))


if __name__ == "__main__":
    unittest.main()
