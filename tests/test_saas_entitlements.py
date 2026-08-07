from __future__ import annotations

import json
import unittest
import uuid

from app.config import SETTINGS_PATH
from saas.entitlements import EntitlementService, EntitlementSet
from saas.errors import ENTITLEMENT_DISABLED, ENTITLEMENT_UNKNOWN, SaasError
from saas.principals import Principal

PLANS = {
    "anonymous": EntitlementService.flatten(
        {
            "image_translation": {"enabled": True, "max_characters_per_job": 1500},
            "pdf_translation": {"enabled": False},
            "rerender": {"enabled": True, "consumes_translation_quota": False},
        }
    ),
    "free": EntitlementService.flatten(
        {
            "image_translation": {"enabled": True, "max_characters_per_job": 1500},
            "pdf_translation": {"enabled": True, "pages_per_period": 12, "max_pages_per_job": 10},
        }
    ),
}


def _principal(plan: str) -> Principal:
    return Principal(tenant="t", kind="anonymous", id=uuid.uuid4(), plan_code=plan)


class EntitlementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = EntitlementService(PLANS)

    def test_anonymous_image_enabled_pdf_disabled(self) -> None:
        entitlements = self.service.resolve(_principal("anonymous"))
        self.assertTrue(entitlements.is_enabled("image_translation.enabled"))
        entitlements.require_enabled("image_translation.enabled")
        self.assertFalse(entitlements.is_enabled("pdf_translation.enabled"))
        with self.assertRaises(SaasError) as ctx:
            entitlements.require_enabled("pdf_translation.enabled")
        self.assertEqual(ctx.exception.code, ENTITLEMENT_DISABLED)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_free_pdf_enabled_with_limits(self) -> None:
        entitlements = self.service.resolve(_principal("free"))
        entitlements.require_enabled("pdf_translation.enabled")
        self.assertEqual(entitlements.get_int("pdf_translation.pages_per_period"), 12)
        self.assertEqual(entitlements.get_int("pdf_translation.max_pages_per_job"), 10)

    def test_missing_key_fails_safe(self) -> None:
        entitlements = self.service.resolve(_principal("anonymous"))
        self.assertFalse(entitlements.is_enabled("voice_translation.enabled"))
        with self.assertRaises(SaasError) as ctx:
            entitlements.get_int("pdf_translation.pages_per_period")
        self.assertEqual(ctx.exception.code, ENTITLEMENT_UNKNOWN)
        # A default makes the absence explicit at the call site instead.
        self.assertEqual(entitlements.get_int("pdf_translation.pages_per_period", 0), 0)

    def test_unknown_plan_resolves_to_empty_set(self) -> None:
        entitlements = self.service.resolve(_principal("enterprise"))
        self.assertEqual(entitlements.plan_code, "enterprise")
        self.assertFalse(entitlements.is_enabled("image_translation.enabled"))
        with self.assertRaises(SaasError):
            entitlements.require_enabled("image_translation.enabled")

    def test_configured_principal_plan_assignment_overrides_default_plan(self) -> None:
        principal = _principal("anonymous")
        service = EntitlementService(
            PLANS,
            plan_assignments={str(principal.id): "free"},
        )

        entitlements = service.resolve(principal)

        self.assertEqual(entitlements.plan_code, "free")
        self.assertEqual(entitlements.get_int("pdf_translation.pages_per_period"), 12)

    def test_snapshot_is_a_stable_copy(self) -> None:
        entitlements = self.service.resolve(_principal("anonymous"))
        snapshot = entitlements.snapshot()
        snapshot["image_translation.enabled"] = False
        self.assertTrue(entitlements.is_enabled("image_translation.enabled"))

    def test_flatten_produces_dotted_keys(self) -> None:
        flat = EntitlementService.flatten({"a": {"b": {"c": 1}, "d": "x"}, "e": True})
        self.assertEqual(flat, {"a.b.c": 1, "a.d": "x", "e": True})

    def test_shipped_free_plan_does_not_promise_document_persistence(self) -> None:
        settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        self.assertFalse(settings["saas"]["plans"]["free"]["document_persistence"]["enabled"])

    def test_shipped_free_plan_has_configurable_character_allowance(self) -> None:
        settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        translation = settings["saas"]["plans"]["free"]["translation"]
        self.assertGreater(translation["characters_per_period"], 0)
        self.assertEqual(translation["period"], "month")


if __name__ == "__main__":
    unittest.main()
