from __future__ import annotations

import json
import unittest
from unittest.mock import patch

import httpx

from realtime_translation_engine.types import LiveDispatchRequest
from realtime_translation_engine.types import TranslationOpportunity

from app.translation_bridge import TranslationBridge
from app.translation_bridge import TranslationServicesError
from app.translation_bridge import translation_language_code


def _service_payload(**overrides: object) -> dict:
    payload = {
        "request_id": "tr_123",
        "translation": "Hello world",
        "source_lang_code": "nl",
        "target_lang_code": "en",
        "applied": {"profile": "general-fast:test", "quality": "fast"},
        "usage": {"input_characters": 12, "output_tokens": 3},
        "warnings": [],
    }
    payload.update(overrides)
    return payload


class TranslationBridgeTests(unittest.TestCase):
    def test_bridge_posts_translation_services_contract(self) -> None:
        captured: dict[str, object] = {}

        def handle(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["payload"] = json.loads(request.content.decode("utf-8"))
            captured["timeout"] = request.extensions["timeout"]["read"]
            return httpx.Response(200, json=_service_payload())

        bridge = TranslationBridge(
            source_language="Dutch",
            target_language="English",
            quality="fast",
        )
        with (
            httpx.Client(transport=httpx.MockTransport(handle)) as client,
            patch("app.translation_bridge.get_upstream_http_client", return_value=client),
            patch("app.translation_bridge.get_str", return_value="http://service:8030"),
            patch("app.translation_bridge.get_float", return_value=45.0),
        ):
            result = bridge.translate("Hallo wereld")

        self.assertEqual(captured["url"], "http://service:8030/v1/translate")
        self.assertEqual(captured["timeout"], 45.0)
        self.assertEqual(
            captured["payload"],
            {
                "source_lang_code": "nl",
                "target_lang_code": "en",
                "text": "Hallo wereld",
                "quality": "fast",
            },
        )
        self.assertEqual(result.text, "Hello world")
        self.assertEqual(result.request_id, "tr_123")
        self.assertEqual(result.profile, "general-fast:test")
        self.assertEqual(result.quality, "fast")
        self.assertEqual(result.metrics.engine_output_tokens, 3)

    def test_live_dispatch_adapter_translates_source_window(self) -> None:
        bridge = TranslationBridge(source_language="Dutch", target_language="English")
        request = LiveDispatchRequest(
            request_id=1,
            committed_target_base_revision=0,
            opportunity=TranslationOpportunity(
                lane="commit",
                source_window="Hallo",
                source_chunks_used=1,
                commits_target=True,
            ),
        )
        with patch.object(bridge, "translate", return_value="result") as translate:
            result = bridge.run(request)

        self.assertEqual(result, "result")
        translate.assert_called_once_with("Hallo")

    def test_same_language_is_forwarded_to_translation_services(self) -> None:
        captured: dict = {}

        def handle(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content.decode("utf-8")))
            return httpx.Response(
                200,
                json=_service_payload(
                    translation="Hallo",
                    source_lang_code="nl",
                    target_lang_code="nl",
                    applied={"profile": "identity:v1", "quality": "fast"},
                ),
            )

        bridge = TranslationBridge(source_language="Dutch", target_language="Dutch")
        with httpx.Client(transport=httpx.MockTransport(handle)) as client, patch(
            "app.translation_bridge.get_upstream_http_client",
            return_value=client,
        ):
            result = bridge.translate("Hallo")

        self.assertEqual(captured["source_lang_code"], "nl")
        self.assertEqual(captured["target_lang_code"], "nl")
        self.assertEqual(result.profile, "identity:v1")

    def test_typed_upstream_error_is_preserved(self) -> None:
        def handle(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                413,
                json={"code": "TEXT_INPUT_TOO_LARGE", "message": "text is too long"},
            )

        bridge = TranslationBridge(source_language="Dutch", target_language="English")
        with httpx.Client(transport=httpx.MockTransport(handle)) as client, patch(
            "app.translation_bridge.get_upstream_http_client",
            return_value=client,
        ):
            with self.assertRaises(TranslationServicesError) as raised:
                bridge.translate("Hallo")

        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(raised.exception.code, "TEXT_INPUT_TOO_LARGE")
        self.assertEqual(str(raised.exception), "text is too long")

    def test_incomplete_success_response_is_rejected(self) -> None:
        def handle(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_service_payload(applied={}))

        bridge = TranslationBridge(source_language="Dutch", target_language="English")
        with httpx.Client(transport=httpx.MockTransport(handle)) as client, patch(
            "app.translation_bridge.get_upstream_http_client",
            return_value=client,
        ):
            with self.assertRaisesRegex(TranslationServicesError, "incomplete response"):
                bridge.translate("Hallo")

    def test_translation_language_code_rejects_unknown_language_name(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported translation language"):
            translation_language_code("Klingon")

    def test_quality_is_limited_to_public_contract(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported translation quality"):
            TranslationBridge(
                source_language="Dutch",
                target_language="English",
                quality="internal-model-name",
            )


if __name__ == "__main__":
    unittest.main()
