"""Text-translation bridge to translation-services.

Typed text and recognized voice text share this client. The app owns admission,
turn state, and retry caching; translation-services owns profiles, prompts,
model selection, output limits, and llm-pool admission.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass

import httpx

from realtime_translation_engine import TranslationMetrics
from realtime_translation_engine.types import LiveDispatchRequest

from app.config import get_float
from app.config import get_str
from app.upstreams.http import get_upstream_http_client


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
    profile: str
    quality: str
    wall_ms: float
    metrics: TranslationMetrics


class TranslationServicesError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502, code: str = "") -> None:
        super().__init__(message)
        self.status_code = int(status_code)
        self.code = str(code)


class TranslationBridge:
    def __init__(
        self,
        *,
        source_language: str,
        target_language: str,
        quality: str = "fast",
    ) -> None:
        self.source_language = str(source_language or "Dutch")
        self.target_language = str(target_language or "English")
        self.source_lang_code = translation_language_code(self.source_language)
        self.target_lang_code = translation_language_code(self.target_language)
        self.quality = str(quality or "fast").strip().lower()
        if self.quality not in {"fast", "best"}:
            raise ValueError(f"unsupported translation quality: {quality!r}")

    def translate(self, source_text: str) -> TranslationRunResult:
        text = str(source_text or "")
        if not text.strip():
            raise ValueError("translation text must not be empty")
        started = time.perf_counter()
        payload = _post_translation(
            {
                "source_lang_code": self.source_lang_code,
                "target_lang_code": self.target_lang_code,
                "text": text,
                "quality": self.quality,
            }
        )
        wall_ms = (time.perf_counter() - started) * 1000.0
        translation = str(payload.get("translation") or "")
        applied = payload.get("applied") if isinstance(payload.get("applied"), dict) else {}
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        profile = str(applied.get("profile") or "")
        quality = str(applied.get("quality") or "")
        if not translation or not profile or quality not in {"fast", "best"}:
            raise TranslationServicesError("incomplete response from translation-services")
        output_tokens = _optional_int(usage.get("output_tokens"))
        return TranslationRunResult(
            text=translation,
            request_id=str(payload.get("request_id") or ""),
            profile=profile,
            quality=quality,
            wall_ms=wall_ms,
            metrics=TranslationMetrics(
                replay_request_wall_ms=wall_ms,
                observed_first_text_ms=wall_ms,
                observed_complete_ms=wall_ms,
                engine_output_tokens=output_tokens,
            ),
        )

    def run(self, request: LiveDispatchRequest) -> TranslationRunResult:
        return self.translate(request.opportunity.source_window)


def translation_language_code(language: str) -> str:
    key = str(language or "").strip().lower()
    if key in _TRANSLATION_LANGUAGE_CODES:
        return _TRANSLATION_LANGUAGE_CODES[key]
    if len(key) == 2 and key.isalpha():
        return key
    raise ValueError(f"unsupported translation language: {language!r}")


def _post_translation(payload: dict) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        response = get_upstream_http_client().post(
            f"{_base_url()}/v1/translate",
            content=body,
            timeout=_timeout_s(),
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
    except httpx.RequestError as exc:
        raise TranslationServicesError(
            f"translation-services unreachable: {exc}"
        ) from exc
    if response.is_error:
        message, code = _http_error(response)
        status_code = response.status_code if 400 <= response.status_code < 500 else 502
        raise TranslationServicesError(message, status_code=status_code, code=code)
    try:
        parsed = response.json()
    except (ValueError, UnicodeDecodeError) as exc:
        raise TranslationServicesError("invalid response from translation-services") from exc
    if not isinstance(parsed, dict):
        raise TranslationServicesError("unexpected response from translation-services")
    return parsed


def _base_url() -> str:
    return get_str("translation_services.base_url", "http://127.0.0.1:8030").rstrip("/")


def _timeout_s() -> float:
    return get_float("translation_services.request_timeout_s", 120.0, min_value=1.0)


def _http_error(response: httpx.Response) -> tuple[str, str]:
    try:
        payload = response.json()
    except ValueError:
        return f"translation-services HTTP {response.status_code}", ""
    if not isinstance(payload, dict):
        return f"translation-services HTTP {response.status_code}", ""
    code = str(payload.get("code") or "")
    message = str(
        payload.get("message")
        or payload.get("detail")
        or code
        or f"translation-services HTTP {response.status_code}"
    )
    return message, code


def _optional_int(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
