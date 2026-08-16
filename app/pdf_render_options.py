"""Validated app-owned render choices for PDF translation requests."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PdfRenderOptions(BaseModel):
    """The render surface the app exposes; defaults are app policy."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    page_layout_mode: Literal["fit", "typeset"] = "typeset"
    page_scale: float = Field(default=0.9, ge=0.5, le=1.0)
    render_size_mode: Literal["min", "median"] = "median"
    erase_fill_mode: Literal["flat", "inpaint"] = "inpaint"
    width_fit_mode: Literal["footprint", "extend_to_margin"] = "footprint"
    size_metric_mode: Literal["extent", "band", "fill"] = "extent"
    size_cohort_mode: Literal["off", "vlm"] = "vlm"
    pdf_output_mode: Literal["vector"] = "vector"
    pdf_structure_mode: Literal["source_only", "always"] = "source_only"


APP_PDF_RENDER_DEFAULTS = PdfRenderOptions()
