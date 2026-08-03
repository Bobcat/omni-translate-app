from __future__ import annotations

import unittest
from datetime import datetime, timezone

from saas.periods import UsagePeriodKind, period_bounds

UTC = timezone.utc


class PeriodBoundsTests(unittest.TestCase):
    def test_week_starts_monday_utc(self) -> None:
        now = datetime(2026, 7, 15, 12, 34, tzinfo=UTC)
        start, end = period_bounds(UsagePeriodKind.WEEK, now=now)
        self.assertEqual(start.weekday(), 0)  # Monday
        self.assertEqual((start.hour, start.minute, start.second), (0, 0, 0))
        self.assertEqual(end - start, __import__("datetime").timedelta(days=7))
        self.assertLessEqual(start, now)
        self.assertLess(now, end)

    def test_week_spans_month_boundary(self) -> None:
        now = datetime(2026, 8, 1, 9, 0, tzinfo=UTC)
        start, end = period_bounds("week", now=now)
        self.assertEqual(start.weekday(), 0)
        self.assertLessEqual(start, now)
        self.assertLess(now, end)

    def test_month_starts_on_the_first(self) -> None:
        now = datetime(2026, 7, 15, 12, 0, tzinfo=UTC)
        start, end = period_bounds(UsagePeriodKind.MONTH, now=now)
        self.assertEqual(start, datetime(2026, 7, 1, tzinfo=UTC))
        self.assertEqual(end, datetime(2026, 8, 1, tzinfo=UTC))

    def test_december_rolls_into_january(self) -> None:
        now = datetime(2026, 12, 20, 12, 0, tzinfo=UTC)
        start, end = period_bounds(UsagePeriodKind.MONTH, now=now)
        self.assertEqual(start, datetime(2026, 12, 1, tzinfo=UTC))
        self.assertEqual(end, datetime(2027, 1, 1, tzinfo=UTC))

    def test_naive_now_is_treated_as_utc(self) -> None:
        start, end = period_bounds("month", now=datetime(2026, 7, 15, 12, 0))
        self.assertEqual(start.tzinfo, UTC)

    def test_unknown_kind_rejected(self) -> None:
        with self.assertRaises(ValueError):
            period_bounds("fortnight", now=datetime(2026, 7, 15, tzinfo=UTC))


if __name__ == "__main__":
    unittest.main()
