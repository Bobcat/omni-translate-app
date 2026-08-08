"""Image entitlement, admission, and source-character ceiling wiring."""
from __future__ import annotations

import json
import unittest
import uuid
from contextlib import nullcontext
from io import BytesIO
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.image_translation_bridge import ImageTranslationError
from app.image_translation_bridge import _terminal_error
from app.image_translation_bridge import translate_image
from app.main import app
from saas.entitlements import EntitlementSet
from saas.fastapi_glue import stage_identity_cookie
from saas.errors import PERIOD_QUOTA_EXCEEDED, RATE_LIMIT_EXCEEDED, RESOURCE_NOT_FOUND, SaasError
from saas.principals import Principal


def _png_bytes() -> bytes:
    from PIL import Image

    out = BytesIO()
    Image.new("RGB", (1, 1), (255, 255, 255)).save(out, format="PNG")
    return out.getvalue()


PNG_BYTES = _png_bytes()
OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000"
ENABLED = EntitlementSet(
    "anonymous",
    {
        "image_translation.enabled": True,
        "image_translation.max_characters_per_job": 1500,
        "image_translation.max_upload_bytes": 1024 * 1024,
        "image_translation.max_image_width": 100,
        "image_translation.max_image_height": 100,
        "image_translation.max_image_pixels": 10_000,
        "image_translation.max_concurrent_jobs": 1,
        "image_translation.max_jobs_per_minute": 3,
        "image_translation.max_jobs_per_hour": 12,
    },
)
PRINCIPAL = Principal(tenant="test", kind="anonymous", id=uuid.uuid4(), plan_code="anonymous")


def _post_image(
    client: TestClient,
    *,
    content: bytes = PNG_BYTES,
    content_type: str = "image/png",
):
    return client.post(
        "/api/image-translation",
        headers={"Idempotency-Key": OPERATION_ID},
        data={"source_language": "auto", "target_language": "English"},
        files={"image": ("photo.png", content, content_type)},
    )


class ImageTranslationRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        # No context manager on purpose: lifespan (ASR warmup) must not run.
        self.client = TestClient(app)
        self._admission_patch = patch(
            "app.router.admit_image_operation",
            return_value=nullcontext(),
        )
        self.admit = self._admission_patch.start()
        self._record_owner_patch = patch("app.router.record_image_request_owner")
        self.record_owner = self._record_owner_patch.start()
        self._require_owner_patch = patch("app.router.require_image_request_owner")
        self.require_owner = self._require_owner_patch.start()
        self._quota_operation_patch = patch(
            "app.router.register_image_quota_operation",
            return_value=False,
        )
        self.register_quota = self._quota_operation_patch.start()

    def tearDown(self) -> None:
        self._quota_operation_patch.stop()
        self._require_owner_patch.stop()
        self._record_owner_patch.stop()
        self._admission_patch.stop()

    def test_plan_ceiling_is_forwarded_and_identity_cookie_issued(self) -> None:
        captured: dict[str, object] = {}

        def fake_translate_image(**kwargs: object):
            captured.update(kwargs)
            return PNG_BYTES, "image/png", OPERATION_ID

        def resolve_with_new_identity(request):
            stage_identity_cookie(request, "tok123")
            return PRINCIPAL, ENABLED, "tok123"

        with (
            patch("app.router.resolve_request_context", side_effect=resolve_with_new_identity),
            patch("app.router.translate_image", fake_translate_image),
        ):
            response = _post_image(self.client)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("x-image-translation-request-id"), OPERATION_ID)
        self.assertEqual(captured.get("operation_id"), OPERATION_ID)
        self.assertEqual(captured.get("max_source_characters"), 1500)
        self.assertFalse(captured.get("quota_authorization_required"))
        self.assertIsNone(captured.get("lifecycle_handler"))
        self.assertIn("ot_anon=tok123", response.headers.get("set-cookie") or "")
        self.record_owner.assert_called_once()
        owner_args = self.record_owner.call_args.args
        self.assertEqual(owner_args[:2], (PRINCIPAL, OPERATION_ID))
        self.assertEqual(len(owner_args[2]), 64)

    def test_metered_plan_forwards_checkpoint_and_lifecycle_handler(self) -> None:
        captured: dict[str, object] = {}

        def fake_translate_image(**kwargs: object):
            captured.update(kwargs)
            handler = kwargs["lifecycle_handler"]
            handler({"request_id": OPERATION_ID, "state": "awaiting_quota"})
            return PNG_BYTES, "image/png", OPERATION_ID

        self.register_quota.return_value = True
        with (
            patch("app.router.resolve_request_context", return_value=(PRINCIPAL, ENABLED, None)),
            patch("app.router.translate_image", fake_translate_image),
            patch("app.router.handle_image_quota_lifecycle") as handle,
        ):
            response = _post_image(self.client)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(captured["quota_authorization_required"])
        handle.assert_called_once_with(
            OPERATION_ID,
            {"request_id": OPERATION_ID, "state": "awaiting_quota"},
            raise_quota_errors=True,
        )

    def test_character_period_rejection_uses_control_error_shape(self) -> None:
        self.register_quota.return_value = True
        rejection = SaasError(
            PERIOD_QUOTA_EXCEEDED,
            "This image needs about 12 translation characters, but only 10 remain this month.",
            status_code=429,
            details={"requested": 12, "remaining": 10},
        )
        with (
            patch("app.router.resolve_request_context", return_value=(PRINCIPAL, ENABLED, None)),
            patch("app.router.translate_image", side_effect=rejection),
        ):
            response = _post_image(self.client)

        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["error"]["code"], PERIOD_QUOTA_EXCEEDED)
        self.assertIn("only 10 remain", response.json()["error"]["message"])

    def test_valid_identity_issues_no_new_cookie(self) -> None:
        def fake_translate_image(**kwargs: object):
            return PNG_BYTES, "image/png", OPERATION_ID

        with (
            patch("app.router.resolve_request_context", return_value=(PRINCIPAL, ENABLED, None)),
            patch("app.router.translate_image", fake_translate_image),
        ):
            response = _post_image(self.client)

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("set-cookie", response.headers)

    def test_disabled_plan_fails_closed(self) -> None:
        disabled = EntitlementSet("anonymous", {})
        with patch(
            "app.router.resolve_request_context",
            return_value=(PRINCIPAL, disabled, None),
        ):
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
            patch("app.router.resolve_request_context", return_value=(PRINCIPAL, ENABLED, None)),
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

    def test_rate_limit_returns_retry_after_without_service_call(self) -> None:
        def reject(*_args, **_kwargs):
            raise SaasError(
                RATE_LIMIT_EXCEEDED,
                "too many image operations",
                status_code=429,
                details={"retry_after_s": 17},
            )

        self.admit.side_effect = reject
        with (
            patch("app.router.resolve_request_context", return_value=(PRINCIPAL, ENABLED, None)),
            patch("app.router.translate_image") as translate,
        ):
            response = _post_image(self.client)

        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["retry-after"], "17")
        self.assertEqual(response.json()["error"]["code"], RATE_LIMIT_EXCEEDED)
        translate.assert_not_called()

    def test_unsupported_media_type_is_rejected_before_admission(self) -> None:
        with (
            patch("app.router.resolve_request_context", return_value=(PRINCIPAL, ENABLED, None)),
            patch("app.router.translate_image") as translate,
        ):
            response = _post_image(self.client, content_type="image/gif")

        self.assertEqual(response.status_code, 415)
        self.admit.assert_not_called()
        translate.assert_not_called()

    def test_dimension_rejection_uses_one_admission_attempt(self) -> None:
        from PIL import Image

        output = BytesIO()
        Image.new("RGB", (101, 1), "white").save(output, format="PNG")
        with (
            patch("app.router.resolve_request_context", return_value=(PRINCIPAL, ENABLED, None)),
            patch("app.router.translate_image") as translate,
        ):
            response = _post_image(self.client, content=output.getvalue())

        self.assertEqual(response.status_code, 422)
        self.admit.assert_called_once_with(PRINCIPAL, ENABLED, OPERATION_ID)
        translate.assert_not_called()

    def test_retranslate_is_admitted_for_the_resolved_principal(self) -> None:
        with (
            patch("app.router.resolve_request_context", return_value=(PRINCIPAL, ENABLED, None)),
            patch(
                "app.router.retranslate_image",
                return_value=(PNG_BYTES, "image/png", OPERATION_ID),
            ) as retranslate,
        ):
            response = self.client.post(
                "/api/image-translation/req_1/retranslate",
                headers={"Idempotency-Key": OPERATION_ID},
                data={"target_language": "German"},
            )
        self.assertEqual(response.status_code, 200)
        self.require_owner.assert_called_once_with(PRINCIPAL, "req_1")
        self.record_owner.assert_called_once()
        self.assertEqual(self.record_owner.call_args.args[:2], (PRINCIPAL, OPERATION_ID))
        self.assertEqual(retranslate.call_args.kwargs["operation_id"], OPERATION_ID)
        self.admit.assert_called_with(PRINCIPAL, ENABLED, OPERATION_ID)

    def test_rerender_is_admitted_for_the_resolved_principal(self) -> None:
        with (
            patch("app.router.resolve_request_context", return_value=(PRINCIPAL, ENABLED, None)),
            patch(
                "app.router.rerender_image",
                return_value=(PNG_BYTES, "image/png", OPERATION_ID),
            ) as rerender,
        ):
            response = self.client.post(
                "/api/image-translation/req_1/rerender",
                headers={"Idempotency-Key": OPERATION_ID},
            )
        self.assertEqual(response.status_code, 200)
        self.require_owner.assert_called_once_with(PRINCIPAL, "req_1")
        self.record_owner.assert_called_once()
        self.assertEqual(self.record_owner.call_args.args[:2], (PRINCIPAL, OPERATION_ID))
        self.assertEqual(rerender.call_args.kwargs["operation_id"], OPERATION_ID)
        self.admit.assert_called_with(PRINCIPAL, ENABLED, OPERATION_ID)

    def test_other_owner_cannot_retranslate(self) -> None:
        self.require_owner.side_effect = SaasError(
            RESOURCE_NOT_FOUND,
            "image request not found",
            status_code=404,
        )
        with (
            patch("app.router.resolve_request_context", return_value=(PRINCIPAL, ENABLED, None)),
            patch("app.router.retranslate_image") as retranslate,
        ):
            response = self.client.post(
                "/api/image-translation/req_other/retranslate",
                headers={"Idempotency-Key": OPERATION_ID},
                data={"target_language": "German"},
            )
        self.assertEqual(response.status_code, 404)
        self.admit.assert_not_called()
        retranslate.assert_not_called()

    def test_status_is_owner_checked_and_proxied(self) -> None:
        envelope = {"request_id": OPERATION_ID, "state": "running"}
        with (
            patch("app.router.resolve_request_context", return_value=(PRINCIPAL, ENABLED, None)),
            patch("app.router.get_image_request", return_value=envelope) as get_request,
        ):
            response = self.client.get(f"/api/image-translation/requests/{OPERATION_ID}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), envelope)
        self.require_owner.assert_called_once_with(PRINCIPAL, OPERATION_ID)
        get_request.assert_called_once_with(OPERATION_ID)

    def test_recovered_artifact_is_private_and_owner_checked(self) -> None:
        with (
            patch("app.router.resolve_request_context", return_value=(PRINCIPAL, ENABLED, None)),
            patch(
                "app.router.get_image_artifact",
                return_value=(PNG_BYTES, "image/png"),
            ) as get_artifact,
        ):
            response = self.client.get(
                f"/api/image-translation/requests/{OPERATION_ID}/artifact"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, PNG_BYTES)
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.require_owner.assert_called_once_with(PRINCIPAL, OPERATION_ID)
        get_artifact.assert_called_once_with(OPERATION_ID)

    def test_cancel_is_owner_checked_and_settles_quota(self) -> None:
        envelope = {"request_id": OPERATION_ID, "state": "cancelled_before_authorization"}
        with (
            patch("app.router.resolve_request_context", return_value=(PRINCIPAL, ENABLED, None)),
            patch("app.router.cancel_image_request", return_value=envelope) as cancel,
            patch("app.router.handle_image_quota_lifecycle") as settle,
        ):
            response = self.client.post(
                f"/api/image-translation/requests/{OPERATION_ID}/cancel"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), envelope)
        self.require_owner.assert_called_once_with(PRINCIPAL, OPERATION_ID)
        cancel.assert_called_once_with(OPERATION_ID)
        settle.assert_called_once_with(OPERATION_ID, envelope)


class BridgeCeilingTests(unittest.TestCase):
    def _run_bridge(
        self,
        max_source_characters: int | None,
        *,
        quota_authorization_required: bool = False,
    ) -> str:
        captured: dict[str, str] = {}

        def fake_submit(
            request_json: str,
            image_bytes: bytes,
            filename: str,
            mime: str,
            *,
            expected_request_id: str,
        ) -> str:
            captured["request_json"] = request_json
            self.assertEqual(expected_request_id, OPERATION_ID)
            return OPERATION_ID

        with (
            patch("app.image_translation_bridge._submit", fake_submit),
            patch("app.image_translation_bridge._await_completion"),
            patch(
                "app.image_translation_bridge._fetch_rendered",
                return_value=(PNG_BYTES, "image/png"),
            ),
        ):
            translate_image(
                operation_id=OPERATION_ID,
                image_bytes=PNG_BYTES,
                filename="photo.png",
                content_type="image/png",
                source_language="auto",
                target_language="English",
                max_source_characters=max_source_characters,
                quota_authorization_required=quota_authorization_required,
            )
        return captured["request_json"]

    def test_ceiling_is_forwarded_to_the_service(self) -> None:
        request = json.loads(self._run_bridge(1500))
        self.assertEqual(request["request_id"], OPERATION_ID)
        self.assertEqual(request["max_source_characters"], 1500)

    def test_no_ceiling_leaves_the_field_out(self) -> None:
        request = json.loads(self._run_bridge(None))
        self.assertNotIn("max_source_characters", request)

    def test_metered_request_asks_service_to_pause_before_translation(self) -> None:
        request = json.loads(self._run_bridge(1500, quota_authorization_required=True))
        self.assertTrue(request["quota_authorization_required"])


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
