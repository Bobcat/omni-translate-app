from __future__ import annotations

import unittest
from unittest.mock import Mock
from unittest.mock import patch

from fastapi.testclient import TestClient
from app.main import app
from app.text_translation_policy import success_cache as text_translation_success_cache
from app.translation_bridge import TranslationBridge
from app.translation_bridge import TranslationServicesError


def _post(client: TestClient, **overrides: object):
    payload = {
        "source_language": "Dutch",
        "target_language": "English",
        "text": "Hallo wereld",
    }
    payload.update(overrides)
    return client.post("/api/text-translation", json=payload)


class TextTranslationRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        # No context manager on purpose: lifespan (ASR warmup) must not run.
        self.client = TestClient(app)
        text_translation_success_cache.clear()

    def test_happy_path_returns_translation(self) -> None:
        captured: dict[str, object] = {}

        def fake_translate(self: TranslationBridge, text: str):
            captured["text"] = text
            captured["bridge"] = self
            return Mock(text="Hello world", profile="general-fast:test", quality="fast")

        with patch.object(TranslationBridge, "translate", fake_translate):
            response = _post(self.client)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "translated_text": "Hello world",
                "profile": "general-fast:test",
                "quality": "fast",
            },
        )
        self.assertEqual(captured["text"], "Hallo wereld")
        bridge = captured["bridge"]
        self.assertEqual((bridge.source_language, bridge.target_language), ("Dutch", "English"))
        self.assertEqual(bridge.quality, "best")

    def test_empty_text_rejected(self) -> None:
        response = _post(self.client, text="   ")
        self.assertEqual(response.status_code, 400)
        self.assertIn("empty text", response.json()["detail"])

    def test_obsolete_final_flag_is_rejected(self) -> None:
        response = _post(self.client, final=True)
        self.assertEqual(response.status_code, 422)

    def test_too_long_text_rejected(self) -> None:
        response = _post(self.client, text="x" * 5001)
        self.assertEqual(response.status_code, 400)
        self.assertIn("text too long", response.json()["detail"])

    def test_exact_character_limit_is_accepted(self) -> None:
        with patch.object(
            TranslationBridge,
            "translate",
            return_value=Mock(text="translated", profile="general-fast:test", quality="fast"),
        ):
            response = _post(self.client, text="x" * 5000)

        self.assertEqual(response.status_code, 200)

    def test_unknown_language_rejected(self) -> None:
        response = _post(self.client, source_language="Klingon")
        self.assertEqual(response.status_code, 400)
        self.assertIn("unsupported translation language", response.json()["detail"])

    def test_translator_failure_is_502(self) -> None:
        calls = 0

        def fake_translate(self: TranslationBridge, text: str):
            del text
            nonlocal calls
            calls += 1
            raise TranslationServicesError("translation-services unreachable")

        with patch.object(TranslationBridge, "translate", fake_translate):
            first = _post(self.client)
            second = _post(self.client)

        self.assertEqual(first.status_code, 502)
        self.assertEqual(second.status_code, 502)
        self.assertIn("translation-services unreachable", first.json()["detail"])
        self.assertEqual(calls, 2)

    def test_identical_successful_retry_uses_short_cache(self) -> None:
        calls = 0

        def fake_translate(self: TranslationBridge, text: str):
            del text
            nonlocal calls
            calls += 1
            return Mock(text="Hello world", profile="general-fast:test", quality="fast")

        with patch.object(TranslationBridge, "translate", fake_translate):
            first = _post(self.client)
            second = _post(self.client)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.json(), first.json())
        self.assertEqual(calls, 1)

if __name__ == "__main__":
    unittest.main()
