from __future__ import annotations

import unittest
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from saas.entitlements import EntitlementService
from saas.errors import SaasError
from saas.fastapi_glue import (
    create_saas_router,
    identity_cookie_middleware,
    resolve_anonymous_identity,
    saas_error_handler,
    stage_identity_cookie,
)
from saas.principals import Principal
from saas.storage import SaasStore
from saas.usage import QuotaService

SECRET = "route-test-secret"


def _make_app(
    db_path: Path,
    *,
    return_store: bool = False,
) -> FastAPI | tuple[FastAPI, SaasStore]:
    store = SaasStore(db_path)
    plans = {
        "anonymous": EntitlementService.flatten(
            {
                "compute": {"credits_per_period": 300, "period": "month"},
                "image_translation": {
                    "enabled": True,
                    "max_characters_per_job": 1500,
                    "jobs_per_period": 12,
                    "period": "month",
                },
                "pdf_translation": {"enabled": True, "max_pages_per_job": 25},
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
                {
                    "metric": "image_translation.jobs",
                    "period_key": "image_translation.period",
                    "limit_key": "image_translation.jobs_per_period",
                }
            ],
        )
    )
    app.add_exception_handler(SaasError, saas_error_handler)
    app.middleware("http")(identity_cookie_middleware)
    if return_store:
        return app, store
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
        self.assertEqual(entry["metric"], "image_translation.jobs")
        self.assertEqual(entry["period"], "month")
        self.assertEqual((entry["reserved"], entry["consumed"]), (0, 0))
        self.assertEqual((entry["limit"], entry["remaining"]), (12, 12))

    def test_usage_never_reports_a_negative_remaining_balance(self) -> None:
        with TemporaryDirectory() as tmp:
            app, store = _make_app(Path(tmp) / "saas.db", return_store=True)
            client = TestClient(app)
            client.get("/api/me")
            principal_id = uuid.UUID(client.cookies["ot_anon"].partition(".")[0])
            principal = Principal(
                tenant="test",
                kind="anonymous",
                id=principal_id,
                plan_code="anonymous",
            )
            reservation = QuotaService(store).reserve(
                principal,
                metric="image_translation.jobs",
                quantity=10,
                limit=12,
                period_kind="month",
                idempotency_key="overrun-test",
            )
            QuotaService(store).consume(reservation.id, actual_quantity=20)

            response = client.get("/api/usage")
            (entry,) = response.json()["usage"]
            self.assertEqual(entry["consumed"], 20)
            self.assertEqual(entry["remaining"], 0)
            store.close()

    def test_credits_summary_counts_reservations_as_unavailable(self) -> None:
        with TemporaryDirectory() as tmp:
            app, store = _make_app(
                Path(tmp) / "saas.db",
                return_store=True,
            )
            client = TestClient(app)
            client.get("/api/me")
            principal_id = uuid.UUID(client.cookies["ot_anon"].partition(".")[0])
            principal = Principal(
                tenant="test",
                kind="anonymous",
                id=principal_id,
                plan_code="anonymous",
            )
            QuotaService(store).reserve(
                principal,
                metric="compute.credits",
                quantity=80,
                limit=300,
                period_kind="month",
                idempotency_key="credits:summary-test",
            )

            response = client.get("/api/credits")
            store.close()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["credits"]["plan"], "anonymous")
        self.assertEqual(response.json()["credits"]["available"], 220)
        self.assertEqual(response.json()["credits"]["grant"], 300)
        self.assertEqual(response.json()["credits"]["period"], "month")
        self.assertTrue(response.json()["credits"]["period_end"])

    def test_credit_activity_is_owner_scoped_and_hides_internal_metadata(self) -> None:
        with TemporaryDirectory() as tmp:
            app, store = _make_app(Path(tmp) / "saas.db", return_store=True)
            with TestClient(app) as owner_client, TestClient(app) as other_client:
                owner_client.get("/api/me")
                other_client.get("/api/me")
                owner = Principal(
                    tenant="test",
                    kind="anonymous",
                    id=uuid.UUID(owner_client.cookies["ot_anon"].partition(".")[0]),
                    plan_code="anonymous",
                )
                other = Principal(
                    tenant="test",
                    kind="anonymous",
                    id=uuid.UUID(other_client.cookies["ot_anon"].partition(".")[0]),
                    plan_code="anonymous",
                )
                quota = QuotaService(store)
                reserved = quota.reserve(
                    owner,
                    metric="compute.credits",
                    quantity=20,
                    limit=300,
                    period_kind="month",
                    idempotency_key="credits:reserved",
                    metadata={"action": "pdf_translation", "payload_hash": "private"},
                )
                consumed = quota.reserve(
                    owner,
                    metric="compute.credits",
                    quantity=30,
                    limit=300,
                    period_kind="month",
                    idempotency_key="credits:consumed",
                    metadata={"action": "pdf_translation"},
                )
                quota.consume(consumed.id)
                released = quota.reserve(
                    owner,
                    metric="compute.credits",
                    quantity=40,
                    limit=300,
                    period_kind="month",
                    idempotency_key="credits:released",
                    metadata={"action": "pdf_translation"},
                )
                quota.release(released.id, "technical failure")
                quota.reserve(
                    other,
                    metric="compute.credits",
                    quantity=99,
                    limit=300,
                    period_kind="month",
                    idempotency_key="credits:other-owner",
                    metadata={"action": "other_owner_work"},
                )
                with store.transaction() as conn:
                    conn.execute(
                        "UPDATE usage_events SET updated_at = ? WHERE id = ?",
                        ("2026-08-31T12:00:00+00:00", str(reserved.id)),
                    )
                    conn.execute(
                        "UPDATE usage_events SET updated_at = ? WHERE id = ?",
                        ("2026-09-01T12:00:00+00:00", str(consumed.id)),
                    )
                    conn.execute(
                        "UPDATE usage_events SET updated_at = ? WHERE id = ?",
                        ("2026-09-02T12:00:00+00:00", str(released.id)),
                    )

                response = owner_client.get("/api/credits/activity")
                filtered_response = owner_client.get(
                    "/api/credits/activity",
                    params={
                        "from_at": "2026-09-01T00:00:00+00:00",
                        "to_before": "2026-09-03T00:00:00+00:00",
                    },
                )
                other_response = other_client.get("/api/credits/activity")
            store.close()

        self.assertEqual(response.status_code, 200)
        activity = response.json()["activity"]
        self.assertEqual(
            [(entry["credits"], entry["state"]) for entry in activity],
            [(40, "released"), (30, "consumed"), (20, "reserved")],
        )
        self.assertTrue(all(entry["action"] == "pdf_translation" for entry in activity))
        self.assertTrue(all(entry["occurred_at"] for entry in activity))
        self.assertTrue(
            all(
                set(entry) == {"action", "credits", "state", "occurred_at"}
                for entry in activity
            )
        )
        self.assertEqual(
            [entry["credits"] for entry in filtered_response.json()["activity"]],
            [40, 30],
        )
        self.assertEqual(other_response.json()["activity"][0]["credits"], 99)
        self.assertEqual(reserved.state, "reserved")

    def test_rejected_first_requests_reuse_one_anonymous_identity(self) -> None:
        with TemporaryDirectory() as tmp:
            store = SaasStore(Path(tmp) / "saas.db")
            app = FastAPI()

            @app.get("/denied")
            def denied(request: Request) -> None:
                _, token = resolve_anonymous_identity(
                    request,
                    store=store,
                    signing_secret=SECRET,
                    tenant="test",
                )
                if token is not None:
                    stage_identity_cookie(request, token)
                raise HTTPException(status_code=403, detail="denied")

            app.middleware("http")(identity_cookie_middleware)
            with TestClient(app) as client:
                first = client.get("/denied")
                second = client.get("/denied")
            with store.transaction() as conn:
                identity_count = conn.execute("SELECT COUNT(*) FROM identities").fetchone()[0]
            store.close()

        self.assertEqual((first.status_code, second.status_code), (403, 403))
        self.assertIn("set-cookie", first.headers)
        self.assertNotIn("set-cookie", second.headers)
        self.assertEqual(identity_count, 1)


if __name__ == "__main__":
    unittest.main()
