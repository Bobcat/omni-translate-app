from __future__ import annotations

import unittest

from app.credits.policy import CreditCostPolicy


POLICY_CONFIG = {
    "version": "credits-v1",
    "quote_ttl_seconds": 900,
    "denomination_eur": "0.001",
    "actions": {
        "pdf_translation": {
            "minimum_credits": 20,
            "credits_per_page": 20,
        }
    },
}


class CreditCostPolicyTests(unittest.TestCase):
    def test_loads_versioned_policy_and_action(self) -> None:
        policy = CreditCostPolicy.from_config(config=POLICY_CONFIG)

        self.assertEqual(policy.version, "credits-v1")
        self.assertEqual(policy.quote_ttl_seconds, 900)
        self.assertEqual(policy.denomination_eur, "0.001")
        self.assertEqual(policy.require_action("pdf_translation")["minimum_credits"], 20)

    def test_rejects_incomplete_policy(self) -> None:
        for key in ("version", "quote_ttl_seconds", "denomination_eur"):
            config = dict(POLICY_CONFIG)
            config.pop(key)
            with self.subTest(key=key), self.assertRaises(ValueError):
                CreditCostPolicy.from_config(config=config)

    def test_rejects_unknown_action(self) -> None:
        policy = CreditCostPolicy.from_config(config=POLICY_CONFIG)

        with self.assertRaises(ValueError):
            policy.require_action("image_translation")


if __name__ == "__main__":
    unittest.main()
