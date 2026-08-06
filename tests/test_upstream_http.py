from __future__ import annotations

import unittest
from unittest.mock import patch

from app.upstreams.http import close_upstream_http_client
from app.upstreams.http import get_upstream_http_client
from app.upstreams.http import open_upstream_http_client


class _Client:
    def __init__(self) -> None:
        self.is_closed = False

    def close(self) -> None:
        self.is_closed = True


class UpstreamHttpLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        close_upstream_http_client()

    def tearDown(self) -> None:
        close_upstream_http_client()

    def test_client_is_reused_until_shutdown_then_reopened(self) -> None:
        first = _Client()
        second = _Client()
        with (
            patch("app.upstreams.http.httpx.Client", side_effect=[first, second]) as factory,
            patch("app.upstreams.http.get_int", return_value=16),
            patch("app.upstreams.http.get_float", return_value=60.0),
        ):
            self.assertIs(open_upstream_http_client(), first)
            self.assertIs(get_upstream_http_client(), first)
            self.assertEqual(factory.call_count, 1)

            close_upstream_http_client()
            self.assertTrue(first.is_closed)

            self.assertIs(open_upstream_http_client(), second)
            self.assertEqual(factory.call_count, 2)


if __name__ == "__main__":
    unittest.main()
