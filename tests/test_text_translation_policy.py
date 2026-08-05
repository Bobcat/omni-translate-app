from __future__ import annotations

import unittest
import uuid

from app.text_translation_policy import TextTranslationSuccessCache
from app.text_translation_policy import text_translation_payload_hash
from saas.principals import Principal


def _principal(identity_id: str) -> Principal:
    return Principal(
        tenant="tenant-a",
        kind="user",
        id=uuid.UUID(identity_id),
        plan_code="free",
    )


class TextTranslationSuccessCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.cache = TextTranslationSuccessCache()
        self.first = _principal("00000000-0000-0000-0000-000000000001")
        self.second = _principal("00000000-0000-0000-0000-000000000002")

    def test_success_is_scoped_to_principal(self) -> None:
        self.cache.put(
            self.first,
            "payload",
            {"translated_text": "Hello", "model": "model-a"},
            ttl_s=30,
            max_entries=10,
            now=100,
        )

        self.assertIsNotNone(self.cache.get(self.first, "payload", now=101))
        self.assertIsNone(self.cache.get(self.second, "payload", now=101))

    def test_expired_success_is_not_returned(self) -> None:
        self.cache.put(
            self.first,
            "payload",
            {"translated_text": "Hello", "model": "model-a"},
            ttl_s=30,
            max_entries=10,
            now=100,
        )

        self.assertIsNone(self.cache.get(self.first, "payload", now=130))

    def test_payload_hash_covers_languages_text_and_final_flag(self) -> None:
        base = text_translation_payload_hash(
            source_language="Dutch",
            target_language="English",
            text="Hallo",
            final=False,
        )
        changed = text_translation_payload_hash(
            source_language="Dutch",
            target_language="English",
            text="Hallo",
            final=True,
        )

        self.assertNotEqual(base, changed)


if __name__ == "__main__":
    unittest.main()
