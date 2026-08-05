from __future__ import annotations

import unittest
from unittest.mock import patch
from unittest.mock import Mock

from realtime_translation_engine import TranslationResult

from app.translation_bridge import TranslateGemmaLlmPoolTranslator
from app.translation_bridge import TranslationBridge
from app.translation_bridge import translation_language_code


class TranslationBridgeTests(unittest.TestCase):
    def test_translategemma_payload_uses_language_codes_without_instructions(self) -> None:
        captured: dict[str, object] = {}

        def submit(translator: TranslateGemmaLlmPoolTranslator, payload: dict[str, object]) -> TranslationResult:
            del translator
            captured.update(payload)
            return TranslationResult(text="Hello", model="translategemma-4b-it-q5-k-m-gguf")

        translator = TranslateGemmaLlmPoolTranslator(
            model="translategemma-4b-it-q5-k-m-gguf",
            source_language="Dutch",
            target_language="English",
        )
        with patch.object(TranslateGemmaLlmPoolTranslator, "_submit_request", submit):
            result = translator.translate("Hallo")

        self.assertEqual(result.text, "Hello")
        self.assertEqual(
            captured,
            {
                "model": "translategemma-4b-it-q5-k-m-gguf",
                "input": "Hallo",
                "source_lang_code": "nl",
                "target_lang_code": "en",
            },
        )
        self.assertNotIn("instructions", captured)
        self.assertNotIn("decoding", captured)

    def test_bridge_uses_translategemma_translator_when_configured(self) -> None:
        values = {
            "translation.model": "translategemma-4b-it-q5-k-m-gguf",
            "translation.second_pass_model": "",
            "translation.prompt": "",
            "translation.request_format": "translategemma_template",
        }

        def fake_get_str(path: str, default: str = "") -> str:
            return values.get(path, default)

        with patch("app.translation_bridge.get_str", side_effect=fake_get_str):
            bridge = TranslationBridge(source_language="Dutch", target_language="English")

        self.assertIsInstance(bridge.translator, TranslateGemmaLlmPoolTranslator)

    def test_bridge_reads_an_explicit_config_namespace(self) -> None:
        values = {
            "text_translation.model": "gemma-4-26b",
            "text_translation.second_pass_model": "",
            "text_translation.prompt": "Translate {{source_lang}} to {{target_lang}}.",
            "text_translation.request_format": "instructions",
        }

        def fake_get_str(path: str, default: str = "") -> str:
            return values.get(path, default)

        translator = Mock()
        with (
            patch("app.translation_bridge.get_str", side_effect=fake_get_str),
            patch("app.translation_bridge.build_translator", return_value=translator) as build,
        ):
            bridge = TranslationBridge(
                source_language="Dutch",
                target_language="English",
                config_namespace="text_translation",
            )

        self.assertIs(bridge.translator, translator)
        self.assertEqual(translator.max_length, 6144)
        build.assert_called_once_with(
            "llm-responses",
            service_model="gemma-4-26b",
            second_pass_model="",
            first_pass_prompt="Translate {{source_lang}} to {{target_lang}}.",
            first_pass_input_template="{{source_window}}",
            source_language="Dutch",
            target_language="English",
        )

    def test_translation_language_code_rejects_unknown_language_name(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported translation language"):
            translation_language_code("Klingon")


if __name__ == "__main__":
    unittest.main()
