"""Phase 4 image quota wiring: the route resolves the caller's entitlements and
forwards the plan's per-image source-character ceiling to translation-services;
the bridge maps the service's rejection onto a structured, presentable error."""
from __future__ import annotations

import json
import unittest
from io import BytesIO
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.image_translation_bridge import ImageTranslationError
from app.image_translation_bridge import _terminal_error
from app.image_translation_bridge import translate_image
from app.main import app
from saas.entitlements import EntitlementSet
from saas.fastapi_glue import stage_identity_cookie


def _png_bytes() -> bytes:
    from PIL import Image

    out = BytesIO()
    Image.new("RGB", (1, 1), (255, 255, 255)).save(out, format="PNG")
    return out.getvalue()


PNG_BYTES = _png_bytes()
ENABLED = EntitlementSet(
    "anonymous",
    {"image_translation.enabled": True, "image_translation.max_characters_per_job": 1500},
)


def _post_image(client: TestClient):
    return client.post(
        "/api/image-translation",
        data={"source_language": "auto", "target_language": "English"},
        files={"image": ("photo.png", PNG_BYTES, "image/png")},
    )


class ImageTranslationRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        # No context manager on purpose: lifespan (ASR warmup) must not run.
        self.client = TestClient(app)

    def test_plan_ceiling_is_forwarded_and_identity_cookie_issued(self) -> None:
        captured: dict[str, object] = {}

        def fake_translate_image(**kwargs: object):
            captured.update(kwargs)
            return PNG_BYTES, "image/png", "req_1"

        def resolve_with_new_identity(request):
            stage_identity_cookie(request, "tok123")
            return ENABLED, "tok123"

        with (
            patch("app.router.resolve_request_entitlements", side_effect=resolve_with_new_identity),
            patch("app.router.translate_image", fake_translate_image),
        ):
            response = _post_image(self.client)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("x-image-translation-request-id"), "req_1")
        self.assertEqual(captured.get("max_source_characters"), 1500)
        self.assertIn("ot_anon=tok123", response.headers.get("set-cookie") or "")

    def test_valid_identity_issues_no_new_cookie(self) -> None:
        def fake_translate_image(**kwargs: object):
            return PNG_BYTES, "image/png", "req_1"

        with (
            patch("app.router.resolve_request_entitlements", return_value=(ENABLED, None)),
            patch("app.router.translate_image", fake_translate_image),
        ):
            response = _post_image(self.client)

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("set-cookie", response.headers)

    def test_disabled_plan_fails_closed(self) -> None:
        disabled = EntitlementSet("anonymous", {})
        with patch("app.router.resolve_request_entitlements", return_value=(disabled, None)):
            response = _post_image(self.client)

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "ENTITLEMENT_DISABLED")

    def test_over_limit_rejection_surfaces_structured_detail(self) -> None:
        def fake_translate_image(**kwargs: object):
            raise ImageTranslationError(
                "This image contains about 2,300 characters of text — the per-image limit is 1,500.",
                status_code=422,
                code="SOURCE_CHARACTER_LIMIT_EXCEEDED",
                details={"source_character_count": 2300, "max_source_characters": 1500},
            )

        with (
            patch("app.router.resolve_request_entitlements", return_value=(ENABLED, None)),
            patch("app.router.translate_image", fake_translate_image),
        ):
            response = _post_image(self.client)

        self.assertEqual(response.status_code, 422)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], "SOURCE_CHARACTER_LIMIT_EXCEEDED")
        self.assertIn("2,300", detail["message"])
        self.assertEqual(
            detail["details"], {"source_character_count": 2300, "max_source_characters": 1500}
        )


class BridgeCeilingTests(unittest.TestCase):
    def _run_bridge(self, max_source_characters: int | None) -> str:
        captured: dict[str, str] = {}

        def fake_submit(request_json: str, image_bytes: bytes, filename: str, mime: str) -> str:
            captured["request_json"] = request_json
            return "req_1"

        with (
            patch("app.image_translation_bridge._submit", fake_submit),
            patch("app.image_translation_bridge._await_completion"),
            patch(
                "app.image_translation_bridge._fetch_rendered",
                return_value=(PNG_BYTES, "image/png"),
            ),
        ):
            translate_image(
                image_bytes=PNG_BYTES,
                filename="photo.png",
                content_type="image/png",
                source_language="auto",
                target_language="English",
                max_source_characters=max_source_characters,
            )
        return captured["request_json"]

    def test_ceiling_is_forwarded_to_the_service(self) -> None:
        request = json.loads(self._run_bridge(1500))
        self.assertEqual(request["max_source_characters"], 1500)

    def test_no_ceiling_leaves_the_field_out(self) -> None:
        request = json.loads(self._run_bridge(None))
        self.assertNotIn("max_source_characters", request)


class TerminalErrorMappingTests(unittest.TestCase):
    def test_character_limit_rejection_keeps_code_and_details(self) -> None:
        payload = {
            "state": "failed",
            "error": {
                "code": "SOURCE_CHARACTER_LIMIT_EXCEEDED",
                "message": "measured 2300 source characters, over the limit of 1500",
                "details": {"source_character_count": 2300, "max_source_characters": 1500},
            },
        }
        exc = _terminal_error(payload, "failed")
        self.assertEqual(exc.status_code, 422)
        self.assertEqual(exc.code, "SOURCE_CHARACTER_LIMIT_EXCEEDED")
        self.assertEqual(
            exc.details, {"source_character_count": 2300, "max_source_characters": 1500}
        )
        self.assertIn("2,300", str(exc))
        self.assertIn("1,500", str(exc))

    def test_generic_failure_stays_a_plain_error(self) -> None:
        payload = {
            "state": "failed",
            "error": {"code": "REQUEST_FAILED", "message": "RuntimeError: boom"},
        }
        exc = _terminal_error(payload, "failed")
        self.assertEqual(exc.status_code, 502)
        self.assertEqual(exc.code, "")
        self.assertEqual(str(exc), "RuntimeError: boom")


if __name__ == "__main__":
    unittest.main()
