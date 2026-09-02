"""Load and validate Omni Translate's versioned credit-cost policy."""
from __future__ import annotations

from dataclasses import dataclass
import math
from types import MappingProxyType
from typing import Any, Mapping


@dataclass(frozen=True)
class CreditCostPolicy:
    version: str
    quote_ttl_seconds: int
    denomination_eur: str
    actions: Mapping[str, Mapping[str, Any]]

    @classmethod
    def from_config(
        cls,
        *,
        config: Mapping[str, Any],
    ) -> "CreditCostPolicy":
        version = str(config.get("version") or "").strip()
        if not version:
            raise ValueError("credit cost policy version is required")
        quote_ttl_seconds = int(config.get("quote_ttl_seconds") or 0)
        if quote_ttl_seconds <= 0:
            raise ValueError("credit quote_ttl_seconds must be positive")
        denomination_eur = str(config.get("denomination_eur") or "").strip()
        if not denomination_eur:
            raise ValueError("credit denomination_eur is required")

        raw_actions = config.get("actions") or {}
        if not isinstance(raw_actions, Mapping):
            raise ValueError("credit cost policy actions must be an object")
        actions: dict[str, Mapping[str, Any]] = {}
        for raw_name, raw_values in raw_actions.items():
            name = str(raw_name).strip()
            if not name or not isinstance(raw_values, Mapping):
                raise ValueError("each credit action must be a named object")
            actions[name] = MappingProxyType(dict(raw_values))

        return cls(
            version=version,
            quote_ttl_seconds=quote_ttl_seconds,
            denomination_eur=denomination_eur,
            actions=MappingProxyType(actions),
        )

    def require_action(self, action: str) -> Mapping[str, Any]:
        try:
            return self.actions[str(action)]
        except KeyError as exc:
            raise ValueError(f"credit action is not configured: {action}") from exc

    def price_pdf_translation(self, *, pages: int, source_characters: int) -> int:
        pages = int(pages)
        source_characters = int(source_characters)
        if pages < 1 or source_characters < 0:
            raise ValueError("PDF pricing requires pages >= 1 and source_characters >= 0")
        values = self.require_action("pdf_translation")
        block_size = int(values["source_character_block_size"])
        if block_size < 1:
            raise ValueError("PDF source_character_block_size must be positive")
        character_blocks = math.ceil(source_characters / block_size)
        return (
            int(values["minimum_credits"])
            + pages * int(values["credits_per_page"])
            + character_blocks * int(values["credits_per_source_character_block"])
        )
