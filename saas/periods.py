"""Calendar usage periods.

Quota resets must never drift into an accidental rolling window: weeks run
Monday 00:00 UTC to the next Monday, months the first 00:00 UTC to the next
first. Isolated here so the rules stay unit-testable.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from enum import Enum


class UsagePeriodKind(str, Enum):
    WEEK = "week"
    MONTH = "month"


def period_bounds(
    kind: UsagePeriodKind | str,
    *,
    now: datetime | None = None,
) -> tuple[datetime, datetime]:
    """Return the [start, end) bounds (aware, UTC) of the period containing
    ``now`` (defaults to the current time)."""
    kind = UsagePeriodKind(kind)
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if kind is UsagePeriodKind.WEEK:
        start = (moment - timedelta(days=moment.weekday())).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        return start, start + timedelta(days=7)
    start = moment.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if start.month == 12:
        return start, start.replace(year=start.year + 1, month=1)
    return start, start.replace(month=start.month + 1)
