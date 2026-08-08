"""Durable app-side ownership for image request IDs."""
from __future__ import annotations

import sqlite3
import unittest
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from app.image_ownership import record_image_request_owner, require_image_request_owner
from app.saas_setup import SaasContext
from saas.entitlements import EntitlementService
from saas.errors import OPERATION_IDEMPOTENCY_CONFLICT, RESOURCE_NOT_FOUND, SaasError
from saas.principals import Principal
from saas.storage import SaasStore
from saas.usage import QuotaService

TENANT = "test"
PAYLOAD_HASH = "a" * 64


def _principal() -> Principal:
    return Principal(tenant=TENANT, kind="user", id=uuid.uuid4(), plan_code="free")


class ImageOwnershipTests(unittest.TestCase):
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
        self.owner = _principal()
        self._context_patch = patch("app.image_ownership.get_saas_context", return_value=self.ctx)
        self._context_patch.start()

    def tearDown(self) -> None:
        self._context_patch.stop()
        self.store.close()
        self._tmp.cleanup()

    def test_recorded_owner_survives_store_reopen(self) -> None:
        record_image_request_owner(self.owner, "request-1", PAYLOAD_HASH)
        self.store.close()
        require_image_request_owner(self.owner, "request-1")

    def test_unknown_and_other_owner_requests_are_hidden(self) -> None:
        record_image_request_owner(self.owner, "request-1", PAYLOAD_HASH)
        for principal, request_id in ((_principal(), "request-1"), (self.owner, "missing")):
            with self.subTest(request_id=request_id):
                with self.assertRaises(SaasError) as caught:
                    require_image_request_owner(principal, request_id)
                self.assertEqual(caught.exception.code, RESOURCE_NOT_FOUND)
                self.assertEqual(caught.exception.status_code, 404)

    def test_existing_request_cannot_be_claimed_by_another_owner(self) -> None:
        record_image_request_owner(self.owner, "request-1", PAYLOAD_HASH)
        with self.assertRaises(SaasError) as caught:
            record_image_request_owner(_principal(), "request-1", PAYLOAD_HASH)
        self.assertEqual(caught.exception.code, RESOURCE_NOT_FOUND)
        self.assertEqual(caught.exception.status_code, 404)
        require_image_request_owner(self.owner, "request-1")

    def test_same_owner_cannot_reuse_operation_for_another_payload(self) -> None:
        record_image_request_owner(self.owner, "request-1", PAYLOAD_HASH)

        with self.assertRaises(SaasError) as caught:
            record_image_request_owner(self.owner, "request-1", "b" * 64)

        self.assertEqual(caught.exception.code, OPERATION_IDEMPOTENCY_CONFLICT)
        self.assertEqual(caught.exception.status_code, 409)

    def test_same_owner_and_payload_replay_is_idempotent(self) -> None:
        record_image_request_owner(self.owner, "request-1", PAYLOAD_HASH)
        record_image_request_owner(self.owner, "request-1", PAYLOAD_HASH)
        require_image_request_owner(self.owner, "request-1")


class ImageOwnershipMigrationTests(unittest.TestCase):
    def test_legacy_owner_rows_survive_payload_hash_migration(self) -> None:
        owner_id = uuid.uuid4()
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "saas.db"
            legacy = sqlite3.connect(path)
            legacy.execute(
                "CREATE TABLE resource_owners ("
                "tenant TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, "
                "owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TEXT NOT NULL, "
                "PRIMARY KEY (tenant, resource_kind, resource_id))"
            )
            legacy.execute(
                "INSERT INTO resource_owners VALUES (?, ?, ?, ?, ?, ?)",
                (TENANT, "image_translation_request", "legacy-request", "user", str(owner_id), "now"),
            )
            legacy.commit()
            legacy.close()

            store = SaasStore(path)
            with store.transaction() as conn:
                columns = {
                    row[1]
                    for row in conn.execute("PRAGMA table_info(resource_owners)")
                }
            owned = store.resource_is_owned_by(
                TENANT,
                "image_translation_request",
                "legacy-request",
                "user",
                owner_id,
            )
            store.close()

        self.assertIn("payload_hash", columns)
        self.assertTrue(owned)
