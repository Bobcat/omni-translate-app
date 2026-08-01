from __future__ import annotations

import unittest
from unittest.mock import Mock
from unittest.mock import patch

from fastapi.testclient import TestClient
from realtime_translation_engine.types import LiveDispatchRequest
from realtime_translation_engine.types import TranslationOpportunity

from app.main import app
from app.translation_bridge import TranslationBridge


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

    def test_happy_path_returns_translation(self) -> None:
        captured: dict[str, object] = {}

        def fake_run(self: TranslationBridge, request: LiveDispatchRequest):
            captured["request"] = request
            captured["bridge"] = self
            return Mock(text="Hello world", model="test-model")

        with patch.object(TranslationBridge, "run", fake_run):
            response = _post(self.client)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"translated_text": "Hello world", "model": "test-model"})
        request = captured["request"]
        self.assertIsInstance(request, LiveDispatchRequest)
        self.assertEqual(request.opportunity.lane, "commit")
        self.assertEqual(request.opportunity.source_window, "Hallo wereld")
        self.assertFalse(request.opportunity.commits_target)
        bridge = captured["bridge"]
        self.assertEqual((bridge.source_language, bridge.target_language), ("Dutch", "English"))

    def test_final_flag_sets_commits_target(self) -> None:
        captured: dict[str, object] = {}

        def fake_run(self: TranslationBridge, request: LiveDispatchRequest):
            captured["request"] = request
            return Mock(text="Hello world", model="test-model")

        with patch.object(TranslationBridge, "run", fake_run):
            response = _post(self.client, final=True)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(captured["request"].opportunity.commits_target)

    def test_empty_text_rejected(self) -> None:
        response = _post(self.client, text="   ")
        self.assertEqual(response.status_code, 400)
        self.assertIn("empty text", response.json()["detail"])

    def test_too_long_text_rejected(self) -> None:
        response = _post(self.client, text="x" * 5001)
        self.assertEqual(response.status_code, 400)
        self.assertIn("text too long", response.json()["detail"])

    def test_unknown_language_rejected(self) -> None:
        response = _post(self.client, source_language="Klingon")
        self.assertEqual(response.status_code, 400)
        self.assertIn("unsupported translation language", response.json()["detail"])

    def test_translator_failure_is_502(self) -> None:
        def fake_run(self: TranslationBridge, request: LiveDispatchRequest):
            raise RuntimeError("llm-pool unreachable")

        with patch.object(TranslationBridge, "run", fake_run):
            response = _post(self.client)

        self.assertEqual(response.status_code, 502)
        self.assertIn("llm-pool unreachable", response.json()["detail"])

    def test_same_language_echoes_without_translator(self) -> None:
        bridge = TranslationBridge(source_language="Dutch", target_language="Dutch")
        request = LiveDispatchRequest(
            request_id=1,
            committed_target_base_revision=0,
            opportunity=TranslationOpportunity(
                lane="commit",
                source_window="Hallo wereld",
                source_chunks_used=1,
                commits_target=False,
            ),
        )
        result = bridge.run(request)
        self.assertEqual(result.text, "Hallo wereld")
        self.assertEqual(result.model, "echo")


if __name__ == "__main__":
    unittest.main()
