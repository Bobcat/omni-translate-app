from __future__ import annotations

import time
from dataclasses import dataclass

from realtime_translation_engine import TranslationMetrics
from realtime_translation_engine import TranslationResult
from realtime_translation_engine.types import LiveDispatchRequest
from realtime_translation_engine.translators import LlmResponsesTranslator
from realtime_translation_engine.translators import build_translator

from app.config import get_str


_TRANSLATION_LANGUAGE_CODES = {
    "afrikaans": "af",
    "arabic": "ar",
    "bengali": "bn",
    "brazilian portuguese": "pt",
    "british english": "en",
    "bulgarian": "bg",
    "chinese": "zh",
    "croatian": "hr",
    "czech": "cs",
    "danish": "da",
    "dutch": "nl",
    "english": "en",
    "finnish": "fi",
    "french": "fr",
    "german": "de",
    "greek": "el",
    "hebrew": "he",
    "hindi": "hi",
    "hungarian": "hu",
    "indonesian": "id",
    "italian": "it",
    "japanese": "ja",
    "korean": "ko",
    "malay": "ms",
    "norwegian": "no",
    "persian": "fa",
    "polish": "pl",
    "portuguese": "pt",
    "romanian": "ro",
    "russian": "ru",
    "slovak": "sk",
    "spanish": "es",
    "swahili": "sw",
    "swedish": "sv",
    "tagalog": "tl",
    "tamil": "ta",
    "thai": "th",
    "turkish": "tr",
    "ukrainian": "uk",
    "urdu": "ur",
    "vietnamese": "vi",
}


@dataclass(frozen=True)
class TranslationRunResult:
    text: str
    request_id: str
    model: str
    first_pass_model: str
    second_pass_model: str
    wall_ms: float
    metrics: TranslationMetrics


class TranslateGemmaLlmPoolTranslator(LlmResponsesTranslator):
    def translate(self, source_window: str) -> TranslationResult:
        source_text = str(source_window or "")
        if source_text.strip() == "":
            return TranslationResult(text="", model=self.model)
        return self._submit_request(
            {
                "model": self.model,
                "input": source_text,
                "source_lang_code": translation_language_code(self.source_language),
                "target_lang_code": translation_language_code(self.target_language),
            }
        )

    def run_second_pass(
        self,
        source_window: str,
        draft_translation: str,
        *,
        system_prompt: str | None = None,
    ) -> TranslationResult:
        del source_window
        del system_prompt
        return TranslationResult(text=str(draft_translation or ""), model=self.model)


class TranslationBridge:
    def __init__(self, *, source_language: str, target_language: str) -> None:
        self.source_language = str(source_language or "Dutch")
        self.target_language = str(target_language or "English")
        # Same-language pair: skip the LLM entirely and echo the source text
        # as the "translation". Originally added to isolate LLM cost during
        # concurrent-session investigation; also avoids a wasted round-trip
        # if a user picks e.g. English -> English.
        self._echo_mode = (
            self.source_language.strip().casefold()
            == self.target_language.strip().casefold()
        )
        self.model = get_str("translation.model", "")
        self.second_pass_model = get_str("translation.second_pass_model", "")
        self.prompt = get_str("translation.prompt", "")
        request_format = get_str("translation.request_format", "instructions").strip().lower()
        if self._echo_mode:
            self.translator = None
        elif request_format == "translategemma_template":
            self.second_pass_model = ""
            self.translator = TranslateGemmaLlmPoolTranslator(
                model=self.model,
                second_pass_model="",
                source_language=self.source_language,
                target_language=self.target_language,
            )
        else:
            self.translator = build_translator(
                "llm-responses",
                service_model=self.model,
                second_pass_model=self.second_pass_model,
                first_pass_prompt=self.prompt,
                first_pass_input_template="{{source_window}}",
                source_language=self.source_language,
                target_language=self.target_language,
            )

    def run(self, request: LiveDispatchRequest) -> TranslationRunResult:
        started = time.perf_counter()
        opportunity = request.opportunity
        if self._echo_mode:
            source_text = str(opportunity.source_window or "")
            wall_ms = (time.perf_counter() - started) * 1000.0
            return TranslationRunResult(
                text=source_text,
                request_id="",
                model="echo",
                first_pass_model="echo",
                second_pass_model="",
                wall_ms=wall_ms,
                metrics=TranslationMetrics(),
            )
        first = self.translator.translate(opportunity.source_window)
        final = first
        second_pass_model = ""
        if opportunity.lane == "commit" and opportunity.commits_target and self.second_pass_model:
            final = self.translator.run_second_pass(opportunity.source_window, first.text)
            second_pass_model = final.model
        wall_ms = (time.perf_counter() - started) * 1000.0
        metrics = final.metrics
        metrics = TranslationMetrics(
            replay_request_wall_ms=wall_ms,
            observed_first_text_ms=wall_ms,
            observed_complete_ms=wall_ms,
            transport_first_byte_ms=metrics.transport_first_byte_ms,
            transport_first_text_delta_ms=metrics.transport_first_text_delta_ms,
            transport_completed_ms=metrics.transport_completed_ms,
            engine_queue_wait_ms=metrics.engine_queue_wait_ms,
            backend_inference_wall_ms=metrics.backend_inference_wall_ms,
            engine_total_wall_ms=metrics.engine_total_wall_ms,
            engine_outside_backend_wall_ms=metrics.engine_outside_backend_wall_ms,
            pool_total_wall_ms=metrics.pool_total_wall_ms,
            engine_tokenize_ms=metrics.engine_tokenize_ms,
            gpu_time_to_first_token_ms=metrics.gpu_time_to_first_token_ms,
            gpu_generate_total_ms=metrics.gpu_generate_total_ms,
            gpu_decode_after_first_token_ms=metrics.gpu_decode_after_first_token_ms,
            engine_prompt_tokens=metrics.engine_prompt_tokens,
            engine_output_tokens=metrics.engine_output_tokens,
            engine_tokens_per_second=metrics.engine_tokens_per_second,
        )
        return TranslationRunResult(
            text=str(final.text or ""),
            request_id=str(final.request_id or ""),
            model=str(final.model or ""),
            first_pass_model=str(first.model or ""),
            second_pass_model=second_pass_model,
            wall_ms=wall_ms,
            metrics=metrics,
        )


def empty_translation_result() -> TranslationResult:
    return TranslationResult(text="", model="")


def translation_language_code(language: str) -> str:
    key = str(language or "").strip().lower()
    if key in _TRANSLATION_LANGUAGE_CODES:
        return _TRANSLATION_LANGUAGE_CODES[key]
    if len(key) == 2 and key.isalpha():
        return key
    raise ValueError(f"unsupported translation language: {language!r}")
