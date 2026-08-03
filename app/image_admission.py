"""Cheap image validation and principal admission before service work starts."""
from __future__ import annotations

import warnings
from io import BytesIO
from typing import BinaryIO

from PIL import Image, UnidentifiedImageError

from app.image_translation_bridge import SUPPORTED_IMAGE_MIME
from saas.admission import AdmissionController
from saas.entitlements import EntitlementSet
from saas.errors import INVALID_UPLOAD, UNSUPPORTED_MEDIA_TYPE, SaasError
from saas.principals import Principal

_FORMAT_MIME = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
}
_controller = AdmissionController()


def read_image_upload(
    file: BinaryIO,
    *,
    content_type: str,
    entitlements: EntitlementSet,
) -> tuple[bytes, str]:
    """Bound the upload read and reject unsupported declared media types."""
    mime = str(content_type or "").split(";", 1)[0].strip().lower()
    if mime not in SUPPORTED_IMAGE_MIME:
        raise SaasError(
            UNSUPPORTED_MEDIA_TYPE,
            f"unsupported image type: {mime or 'unknown'}",
            status_code=415,
            details={"content_type": mime or "unknown"},
        )
    max_bytes = entitlements.get_int("image_translation.max_upload_bytes")
    content = file.read(max_bytes + 1)
    if not content:
        raise SaasError(INVALID_UPLOAD, "empty image upload", status_code=400)
    if len(content) > max_bytes:
        raise SaasError(
            INVALID_UPLOAD,
            f"image too large (max {max_bytes // (1024 * 1024)} MB)",
            status_code=413,
            details={"max_upload_bytes": max_bytes},
        )
    return content, mime


def validate_image_upload(
    content: bytes,
    *,
    declared_mime: str,
    entitlements: EntitlementSet,
) -> None:
    """Verify image content and dimensions without decoding full pixel data."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content)) as image:
                width, height = image.size
                actual_mime = _FORMAT_MIME.get(str(image.format or "").upper(), "")
                image.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise SaasError(
            INVALID_UPLOAD,
            "the uploaded file is not a safe readable image",
            status_code=400,
        ) from exc

    if actual_mime != declared_mime:
        raise SaasError(
            INVALID_UPLOAD,
            "the uploaded image content does not match its media type",
            status_code=400,
            details={"declared_type": declared_mime, "detected_type": actual_mime or "unknown"},
        )

    max_width = entitlements.get_int("image_translation.max_image_width")
    max_height = entitlements.get_int("image_translation.max_image_height")
    max_pixels = entitlements.get_int("image_translation.max_image_pixels")
    pixels = int(width) * int(height)
    if width > max_width or height > max_height or pixels > max_pixels:
        raise SaasError(
            INVALID_UPLOAD,
            "image dimensions exceed the processing limit",
            status_code=422,
            details={
                "width": width,
                "height": height,
                "pixels": pixels,
                "max_width": max_width,
                "max_height": max_height,
                "max_pixels": max_pixels,
            },
        )


def admit_image_operation(principal: Principal, entitlements: EntitlementSet):
    """One shared operational limit for translate, retranslate, and rerender."""
    return _controller.admit(
        principal,
        operation="image_processing",
        max_per_minute=entitlements.get_int("image_translation.max_jobs_per_minute"),
        max_per_hour=entitlements.get_int("image_translation.max_jobs_per_hour"),
        max_concurrent=entitlements.get_int("image_translation.max_concurrent_jobs"),
    )
