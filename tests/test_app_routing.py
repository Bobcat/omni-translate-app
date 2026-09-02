from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


class AppRoutingTests(unittest.TestCase):
    def test_guest_credit_reset_rotates_identity_and_removes_query_parameter(self) -> None:
        with (
            patch("app.main.stage_fresh_anonymous_identity") as reset_identity,
            TestClient(app) as client,
        ):
            response = client.get(
                "/?desktop&resetguestcredits",
                follow_redirects=False,
            )

        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers["location"], "/?desktop=")
        reset_identity.assert_called_once()


if __name__ == "__main__":
    unittest.main()
