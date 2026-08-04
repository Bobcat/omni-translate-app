"""Durable app-side ownership for image request IDs."""
from __future__ import annotations

import unittest
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from app.image_ownership import record_image_request_owner, require_image_request_owner
from app.saas_setup import SaasContext
from saas.entitlements import EntitlementService
from saas.errors import RESOURCE_NOT_FOUND, SaasError
from saas.principals import Principal
from saas.storage import SaasStore
from saas.usage import QuotaService

TENANT = "test"


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
        record_image_request_owner(self.owner, "request-1")
        self.store.close()
        require_image_request_owner(self.owner, "request-1")

    def test_unknown_and_other_owner_requests_are_hidden(self) -> None:
        record_image_request_owner(self.owner, "request-1")
        for principal, request_id in ((_principal(), "request-1"), (self.owner, "missing")):
            with self.subTest(request_id=request_id):
                with self.assertRaises(SaasError) as caught:
                    require_image_request_owner(principal, request_id)
                self.assertEqual(caught.exception.code, RESOURCE_NOT_FOUND)
                self.assertEqual(caught.exception.status_code, 404)

    def test_existing_request_cannot_be_claimed_by_another_owner(self) -> None:
        record_image_request_owner(self.owner, "request-1")
        with self.assertRaises(RuntimeError):
            record_image_request_owner(_principal(), "request-1")
        require_image_request_owner(self.owner, "request-1")
