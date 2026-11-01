"""Validated app-owned render choices for PDF translation requests."""
from __future__ import annotations

from typing import Annotated
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PdfRenderOptions(BaseModel):
    """The render surface the app exposes; defaults are app policy. Only fields the service's
    PDF request takes: it refuses any other."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    # "auto" lets translation-services choose one type scale of 1.00 to 0.85 for the whole
    # document before any text is shortened; a number sets it.
    page_scale: Annotated[float, Field(ge=0.5, le=1.0)] | Literal["auto"] = "auto"
    erase_fill_mode: Literal["flat", "inpaint"] = "inpaint"
    pdf_output_mode: Literal["vector"] = "vector"
    pdf_structure_mode: Literal["source_only", "always"] = "source_only"


APP_PDF_RENDER_DEFAULTS = PdfRenderOptions()
