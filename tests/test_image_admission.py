"""Image upload preflight limits before translation-services admission."""
from __future__ import annotations

import io
import unittest

from PIL import Image

from app.image_admission import read_image_upload, validate_image_upload
from saas.entitlements import EntitlementSet
from saas.errors import INVALID_UPLOAD, UNSUPPORTED_MEDIA_TYPE, SaasError


def _image_bytes(format_name: str = "PNG", *, size: tuple[int, int] = (10, 10)) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", size, "white").save(output, format=format_name)
    return output.getvalue()


def _entitlements(**overrides: int) -> EntitlementSet:
    values = {
        "image_translation.max_upload_bytes": 1024,
        "image_translation.max_image_width": 100,
        "image_translation.max_image_height": 100,
        "image_translation.max_image_pixels": 10_000,
    }
    values.update(overrides)
    return EntitlementSet("test", values)


class ImageUploadAdmissionTests(unittest.TestCase):
    def test_read_is_bounded_to_one_byte_past_the_limit(self) -> None:
        stream = io.BytesIO(b"x" * 100)
        with self.assertRaises(SaasError) as caught:
            read_image_upload(
                stream,
                content_type="image/png",
                entitlements=_entitlements(**{"image_translation.max_upload_bytes": 10}),
            )
        self.assertEqual(caught.exception.code, INVALID_UPLOAD)
        self.assertEqual(caught.exception.status_code, 413)
        self.assertEqual(stream.tell(), 11)

    def test_unsupported_declared_media_type_is_rejected(self) -> None:
        with self.assertRaises(SaasError) as caught:
            read_image_upload(
                io.BytesIO(b"image"),
                content_type="image/gif",
                entitlements=_entitlements(),
            )
        self.assertEqual(caught.exception.code, UNSUPPORTED_MEDIA_TYPE)
        self.assertEqual(caught.exception.status_code, 415)

    def test_declared_media_type_must_match_image_content(self) -> None:
        with self.assertRaises(SaasError) as caught:
            validate_image_upload(
                _image_bytes("PNG"),
                declared_mime="image/jpeg",
                entitlements=_entitlements(),
            )
        self.assertEqual(caught.exception.code, INVALID_UPLOAD)
        self.assertEqual(caught.exception.details["detected_type"], "image/png")

    def test_pixel_limit_is_checked_without_service_work(self) -> None:
        with self.assertRaises(SaasError) as caught:
            validate_image_upload(
                _image_bytes(size=(20, 20)),
                declared_mime="image/png",
                entitlements=_entitlements(**{"image_translation.max_image_pixels": 300}),
            )
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(caught.exception.details["pixels"], 400)

    def test_valid_image_passes(self) -> None:
        validate_image_upload(
            _image_bytes(),
            declared_mime="image/png",
            entitlements=_entitlements(),
        )


if __name__ == "__main__":
    unittest.main()
