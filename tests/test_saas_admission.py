"""Atomic process-local rate and concurrency admission."""
from __future__ import annotations

import unittest
import uuid

from saas.admission import AdmissionController
from saas.errors import RATE_LIMIT_EXCEEDED, SaasError
from saas.principals import Principal


def _principal() -> Principal:
    return Principal(tenant="t", kind="anonymous", id=uuid.uuid4(), plan_code="anonymous")


class AdmissionControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = AdmissionController()
        self.principal = _principal()

    def _admit(
        self,
        *,
        now: float,
        minute: int = 5,
        hour: int = 30,
        concurrent: int = 1,
        idempotency_key: str | None = None,
    ):
        return self.controller.admit(
            self.principal,
            operation="image_processing",
            max_per_minute=minute,
            max_per_hour=hour,
            max_concurrent=concurrent,
            idempotency_key=idempotency_key,
            now=now,
        )

    def test_one_in_flight_operation_blocks_a_second(self) -> None:
        with self._admit(now=0):
            with self.assertRaises(SaasError) as caught:
                with self._admit(now=1):
                    pass
        self.assertEqual(caught.exception.code, RATE_LIMIT_EXCEEDED)
        self.assertEqual(caught.exception.details["constraint"], "concurrent")
        self.assertEqual(caught.exception.details["retry_after_s"], 5)

    def test_releasing_the_lease_opens_the_concurrency_slot(self) -> None:
        with self._admit(now=0):
            pass
        with self._admit(now=1):
            pass

    def test_same_active_idempotency_key_reuses_one_admission(self) -> None:
        with self._admit(now=0, minute=1, idempotency_key="operation-a"):
            with self._admit(now=1, minute=1, idempotency_key="operation-a"):
                with self.assertRaises(SaasError) as caught:
                    with self._admit(now=2, minute=1, idempotency_key="operation-b"):
                        pass
        self.assertEqual(caught.exception.details["constraint"], "concurrent")

        with self.assertRaises(SaasError) as caught:
            with self._admit(now=3, minute=1, idempotency_key="operation-b"):
                pass
        self.assertEqual(caught.exception.details["constraint"], "rate")

    def test_admitted_failure_still_counts_toward_the_rate(self) -> None:
        with self.assertRaises(RuntimeError):
            with self._admit(now=0, minute=2):
                raise RuntimeError("pipeline failed")
        with self._admit(now=10, minute=2):
            pass
        with self.assertRaises(SaasError):
            with self._admit(now=20, minute=2):
                pass

    def test_minute_limit_returns_exact_retry_delay(self) -> None:
        with self._admit(now=0, minute=2):
            pass
        with self._admit(now=10, minute=2):
            pass
        with self.assertRaises(SaasError) as caught:
            with self._admit(now=20, minute=2):
                pass
        self.assertEqual(caught.exception.details["window_s"], 60)
        self.assertEqual(caught.exception.details["retry_after_s"], 40)

    def test_hour_limit_survives_the_minute_window(self) -> None:
        with self._admit(now=0, minute=5, hour=2):
            pass
        with self._admit(now=61, minute=5, hour=2):
            pass
        with self.assertRaises(SaasError) as caught:
            with self._admit(now=120, minute=5, hour=2):
                pass
        self.assertEqual(caught.exception.details["window_s"], 3600)
        self.assertEqual(caught.exception.details["retry_after_s"], 3480)

    def test_principals_have_independent_windows(self) -> None:
        with self._admit(now=0, minute=1):
            pass
        other = _principal()
        with self.controller.admit(
            other,
            operation="image_processing",
            max_per_minute=1,
            max_per_hour=1,
            max_concurrent=1,
            now=1,
        ):
            pass


if __name__ == "__main__":
    unittest.main()
