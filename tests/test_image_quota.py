"""Image character quota authorization and server-side reconciliation."""
from __future__ import annotations

import asyncio
import json
import unittest
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from app.image_quota import CHARACTERS_METRIC
from app.image_quota import IMAGE_QUOTA_OPERATION
from app.image_quota import handle_image_quota_lifecycle
from app.image_quota import reconcile_image_quota_operations
from app.image_quota import register_image_quota_operation
from app.image_quota import run_image_quota_reconciliation_loop
from app.image_translation_bridge import ImageTranslationError
from app.saas_setup import SaasContext
from saas.entitlements import EntitlementService, EntitlementSet
from saas.errors import PERIOD_QUOTA_EXCEEDED, SaasError
from saas.principals import Principal
from saas.storage import SaasStore
from saas.usage import QuotaService

TENANT = "test"


class ImageQuotaTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.store = SaasStore(Path(self._tmp.name) / "saas.db")
        self.ctx = SaasContext(
            store=self.store,
            entitlement_service=EntitlementService({}),
            quota_service=QuotaService(self.store),
            signing_secret="test",
            tenant=TENANT,
            token_verifier=None,
            user_plan="free",
        )
        self.principal = Principal(
            tenant=TENANT,
            kind="user",
            id=uuid.uuid4(),
            plan_code="free",
        )
        self.entitlements = EntitlementSet(
            "free",
            {
                "translation.characters_per_period": 100,
                "translation.period": "month",
            },
        )
        self._context_patch = patch("app.image_quota.get_saas_context", return_value=self.ctx)
        self._context_patch.start()

    def tearDown(self) -> None:
        self._context_patch.stop()
        self.store.close()
        self._tmp.cleanup()

    def _operation_id(self) -> str:
        return str(uuid.uuid4())

    @staticmethod
    def _awaiting(operation_id: str, count: int = 12) -> dict:
        return {
            "request_id": operation_id,
            "state": "awaiting_quota",
            "quota": {
                "source_character_counting_version": "semantic-codepoints-v1",
                "source_character_count": count,
                "source_character_raw_count": count + 4,
                "source_character_preserved_count": 2,
                "source_character_decoration_count": 2,
            },
        }

    def _register(self, operation_id: str, entitlements: EntitlementSet | None = None) -> None:
        self.assertTrue(
            register_image_quota_operation(
                self.principal,
                entitlements or self.entitlements,
                operation_id,
            )
        )

    def _event(self, operation_id: str):
        return self.store.get_usage_event_by_key(
            TENANT,
            self.principal.kind,
            self.principal.id,
            f"image-characters:{operation_id}",
        )

    def _operation(self, operation_id: str):
        return self.store.get_quota_operation(TENANT, IMAGE_QUOTA_OPERATION, operation_id)

    def test_anonymous_plan_without_period_allowance_stays_unmetered(self) -> None:
        operation_id = self._operation_id()
        self.assertFalse(
            register_image_quota_operation(
                self.principal,
                EntitlementSet("anonymous", {}),
                operation_id,
            )
        )
        self.assertIsNone(self._operation(operation_id))

    def test_awaiting_reserves_records_counter_and_authorizes_idempotently(self) -> None:
        operation_id = self._operation_id()
        self._register(operation_id)
        authorized = {"request_id": operation_id, "state": "queued"}
        with patch("app.image_quota.authorize_image_request", return_value=authorized) as authorize:
            first = handle_image_quota_lifecycle(operation_id, self._awaiting(operation_id))
            second = handle_image_quota_lifecycle(operation_id, self._awaiting(operation_id))

        self.assertEqual((first, second), ("authorized", "authorized"))
        event = self._event(operation_id)
        self.assertEqual(
            (event["metric"], event["quantity"], event["state"]),
            (CHARACTERS_METRIC, 12, "reserved"),
        )
        metadata = json.loads(str(event["metadata"]))
        self.assertEqual(metadata["source_character_counting_version"], "semantic-codepoints-v1")
        self.assertEqual(metadata["source_character_decoration_count"], 2)
        self.assertEqual(str(self._operation(operation_id)["state"]), "authorized")
        self.assertEqual(authorize.call_count, 2)

    def test_retry_keeps_the_original_entitlement_snapshot(self) -> None:
        operation_id = self._operation_id()
        self._register(operation_id)
        stricter = EntitlementSet(
            "free",
            {
                "translation.characters_per_period": 1,
                "translation.period": "month",
            },
        )
        self.assertTrue(register_image_quota_operation(self.principal, stricter, operation_id))
        with patch(
            "app.image_quota.authorize_image_request",
            return_value={"request_id": operation_id, "state": "queued"},
        ):
            self.assertEqual(
                handle_image_quota_lifecycle(operation_id, self._awaiting(operation_id)),
                "authorized",
            )
        self.assertEqual(int(self._event(operation_id)["quantity"]), 12)

    def test_lost_authorize_response_is_recovered_from_service_state(self) -> None:
        operation_id = self._operation_id()
        self._register(operation_id)
        with patch(
            "app.image_quota.authorize_image_request",
            side_effect=ImageTranslationError("response lost", status_code=502),
        ):
            with self.assertRaises(ImageTranslationError):
                handle_image_quota_lifecycle(operation_id, self._awaiting(operation_id))
        self.assertEqual(str(self._operation(operation_id)["state"]), "reserved")
        with patch(
            "app.image_quota.get_image_request",
            return_value={"request_id": operation_id, "state": "running"},
        ):
            self.assertEqual(reconcile_image_quota_operations(), 1)
        self.assertEqual(str(self._operation(operation_id)["state"]), "authorized")

    def test_completed_consumes_and_technical_failure_releases(self) -> None:
        for terminal, expected in (
            ({"state": "completed"}, "consumed"),
            ({"state": "cancelled"}, "consumed"),
            (
                {
                    "state": "failed",
                    "error": {"code": "REQUEST_INTERRUPTED_BY_RESTART"},
                },
                "released",
            ),
            (
                {"state": "failed", "error": {"code": "INPUT_REJECTED"}},
                "consumed",
            ),
            ({"state": "cancelled_before_authorization"}, "released"),
        ):
            with self.subTest(state=terminal["state"]):
                operation_id = self._operation_id()
                self._register(operation_id)
                with patch(
                    "app.image_quota.authorize_image_request",
                    return_value={"request_id": operation_id, "state": "queued"},
                ):
                    handle_image_quota_lifecycle(operation_id, self._awaiting(operation_id))
                envelope = {"request_id": operation_id, **terminal}
                handle_image_quota_lifecycle(operation_id, envelope)
                event = self._event(operation_id)
                self.assertEqual(str(event["state"]), expected)
                metadata = json.loads(str(event["metadata"]))
                self.assertEqual(
                    metadata["source_character_counting_version"],
                    "semantic-codepoints-v1",
                )

    def test_over_period_limit_cancels_before_authorization_and_replays_rejection(self) -> None:
        operation_id = self._operation_id()
        self._register(
            operation_id,
            EntitlementSet(
                "free",
                {
                    "translation.characters_per_period": 10,
                    "translation.period": "month",
                },
            ),
        )
        with patch(
            "app.image_quota.cancel_image_request",
            return_value={"request_id": operation_id, "state": "cancelled_before_authorization"},
        ) as cancel:
            with self.assertRaises(SaasError) as caught:
                handle_image_quota_lifecycle(
                    operation_id,
                    self._awaiting(operation_id, count=12),
                    raise_quota_errors=True,
                )
        self.assertEqual(caught.exception.code, PERIOD_QUOTA_EXCEEDED)
        self.assertIn("12", str(caught.exception))
        self.assertIn("10", str(caught.exception))
        cancel.assert_called_once_with(operation_id)
        self.assertIsNone(self._event(operation_id))
        self.assertEqual(str(self._operation(operation_id)["state"]), "rejected")
        with self.assertRaises(SaasError) as replayed:
            register_image_quota_operation(self.principal, self.entitlements, operation_id)
        self.assertEqual(replayed.exception.code, PERIOD_QUOTA_EXCEEDED)
        self.assertEqual(str(replayed.exception), str(caught.exception))

    def test_background_reconciler_authorizes_without_browser_state(self) -> None:
        operation_id = self._operation_id()
        self._register(operation_id)
        with (
            patch(
                "app.image_quota.get_image_request",
                return_value=self._awaiting(operation_id),
            ),
            patch(
                "app.image_quota.authorize_image_request",
                return_value={"request_id": operation_id, "state": "queued"},
            ),
        ):
            self.assertEqual(reconcile_image_quota_operations(), 1)
        self.assertEqual(str(self._event(operation_id)["state"]), "reserved")
        self.assertEqual(str(self._operation(operation_id)["state"]), "authorized")
        with patch(
            "app.image_quota.get_image_request",
            return_value={"request_id": operation_id, "state": "completed"},
        ):
            self.assertEqual(reconcile_image_quota_operations(), 1)
        self.assertEqual(str(self._event(operation_id)["state"]), "consumed")

    def test_missing_authorized_job_consumes_only_after_grace(self) -> None:
        operation_id = self._operation_id()
        self._register(operation_id)
        with patch(
            "app.image_quota.authorize_image_request",
            return_value={"request_id": operation_id, "state": "queued"},
        ):
            handle_image_quota_lifecycle(operation_id, self._awaiting(operation_id))
        created_at = datetime.fromisoformat(str(self._operation(operation_id)["created_at"]))
        missing = ImageTranslationError("not found", status_code=404)
        with patch("app.image_quota.get_image_request", side_effect=missing):
            self.assertEqual(
                reconcile_image_quota_operations(
                    now=created_at + timedelta(hours=23),
                    missing_grace_s=24 * 60 * 60,
                ),
                0,
            )
            self.assertEqual(
                reconcile_image_quota_operations(
                    now=created_at + timedelta(hours=25),
                    missing_grace_s=24 * 60 * 60,
                ),
                1,
            )
        self.assertEqual(str(self._event(operation_id)["state"]), "consumed")
        self.assertEqual(str(self._operation(operation_id)["state"]), "missing")

    def test_service_outage_leaves_operation_open(self) -> None:
        operation_id = self._operation_id()
        self._register(operation_id)
        with patch(
            "app.image_quota.get_image_request",
            side_effect=ImageTranslationError("unreachable", status_code=502),
        ):
            self.assertEqual(reconcile_image_quota_operations(missing_grace_s=0), 0)
        self.assertEqual(str(self._operation(operation_id)["state"]), "created")


class ImageQuotaLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_loop_runs_before_sleeping(self) -> None:
        with (
            patch("app.image_quota.reconcile_image_quota_operations") as reconcile,
            patch(
                "app.image_quota.asyncio.sleep",
                new=AsyncMock(side_effect=asyncio.CancelledError),
            ),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await run_image_quota_reconciliation_loop()
        reconcile.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
