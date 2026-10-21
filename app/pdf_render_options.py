"""Validated app-owned render choices for PDF translation requests."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PdfRenderOptions(BaseModel):
    """The render surface the app exposes; defaults are app policy. Only fields the service's
    PDF request takes: it refuses any other."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    page_scale: float = Field(default=0.9, ge=0.5, le=1.0)
    erase_fill_mode: Literal["flat", "inpaint"] = "inpaint"
    pdf_output_mode: Literal["vector"] = "vector"
    pdf_structure_mode: Literal["source_only", "always"] = "source_only"


APP_PDF_RENDER_DEFAULTS = PdfRenderOptions()
