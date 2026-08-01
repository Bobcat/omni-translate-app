from __future__ import annotations

import unittest
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import FastAPI
from fastapi.testclient import TestClient

from saas.entitlements import EntitlementService
from saas.errors import SaasError
from saas.fastapi_glue import create_saas_router, saas_error_handler
from saas.storage import SaasStore
from saas.usage import QuotaService

SECRET = "route-test-secret"


def _make_app(db_path: Path) -> FastAPI:
    store = SaasStore(db_path)
    plans = {
        "anonymous": EntitlementService.flatten(
            {
                "image_translation": {"enabled": True, "max_characters_per_job": 1500},
                "pdf_translation": {"enabled": True, "pages_per_period": 12},
            }
        )
    }
    app = FastAPI()
    app.include_router(
        create_saas_router(
            store=store,
            entitlement_service=EntitlementService(plans),
            quota_service=QuotaService(store),
            signing_secret=SECRET,
            tenant="test",
            usage_metrics=[
                {"metric": "pdf_translation.pages", "period": "month", "limit_key": "pdf_translation.pages_per_period"}
            ],
        )
    )
    app.add_exception_handler(SaasError, saas_error_handler)
    return app


class SaasRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.client = TestClient(_make_app(Path(self._tmp.name) / "saas.db"))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_me_issues_anonymous_principal_and_cookie(self) -> None:
        response = self.client.get("/api/me")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"principal": {"kind": "anonymous", "plan": "anonymous"}})
        token = self.client.cookies.get("ot_anon")
        self.assertTrue(token)
        raw_id, _, signature = token.partition(".")
        uuid.UUID(raw_id)  # parses
        self.assertTrue(signature)

    def test_me_reuses_the_identity_from_a_valid_cookie(self) -> None:
        first = self.client.get("/api/me")
        self.assertIn("set-cookie", first.headers)
        second = self.client.get("/api/me")
        self.assertNotIn("set-cookie", second.headers)

    def test_forged_cookie_is_replaced_by_a_fresh_identity(self) -> None:
        forged = f"{uuid.uuid4()}.forged"
        response = self.client.get("/api/me", cookies={"ot_anon": forged})
        self.assertEqual(response.status_code, 200)
        token = response.cookies.get("ot_anon")
        self.assertTrue(token)
        self.assertNotIn("forged", token)

    def test_entitlements_reflect_the_anonymous_plan(self) -> None:
        response = self.client.get("/api/entitlements")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["plan"], "anonymous")
        self.assertTrue(payload["entitlements"]["image_translation.enabled"])
        self.assertEqual(payload["entitlements"]["image_translation.max_characters_per_job"], 1500)

    def test_usage_reports_limit_and_remaining(self) -> None:
        response = self.client.get("/api/usage")
        self.assertEqual(response.status_code, 200)
        (entry,) = response.json()["usage"]
        self.assertEqual(entry["metric"], "pdf_translation.pages")
        self.assertEqual(entry["period"], "month")
        self.assertEqual((entry["reserved"], entry["consumed"]), (0, 0))
        self.assertEqual((entry["limit"], entry["remaining"]), (12, 12))


if __name__ == "__main__":
    unittest.main()
