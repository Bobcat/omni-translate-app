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
    "arabic": "ar",
    "brazilian portuguese": "pt",
    "british english": "en",
    "chinese": "zh",
    "dutch": "nl",
    "english": "en",
    "french": "fr",
    "german": "de",
    "hindi": "hi",
    "italian": "it",
    "japanese": "ja",
    "korean": "ko",
    "polish": "pl",
    "portuguese": "pt",
    "spanish": "es",
    "turkish": "tr",
    "ukrainian": "uk",
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
        self.model = get_str("translation.model", "")
        self.second_pass_model = get_str("translation.second_pass_model", "")
        self.prompt = get_str("translation.prompt", "")
        request_format = get_str("translation.request_format", "instructions").strip().lower()
        if request_format == "translategemma_template":
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
