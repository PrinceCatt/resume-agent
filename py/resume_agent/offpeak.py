"""DeepSeek's peak hours (port of src/offpeak.ts): Beijing time (UTC+8, the same clock as Singapore)
Monday to Friday 9:00-12:00 and 14:00-18:00. Public holidays are treated as normal weekdays."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

BJ = timezone(timedelta(hours=8))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def is_peak(d: datetime | None = None) -> bool:
    bj = (d or _now()).astimezone(BJ)
    day = bj.isoweekday()  # 1 = Monday ... 7 = Sunday
    m = bj.hour * 60 + bj.minute
    return 1 <= day <= 5 and ((9 * 60 <= m < 12 * 60) or (14 * 60 <= m < 18 * 60))


def peak_ends(d: datetime | None = None) -> datetime | None:
    """When the current peak ends (12:00 or 18:00 Beijing time); None when it is off-peak now."""
    d = d or _now()
    if not is_peak(d):
        return None
    bj = d.astimezone(BJ)
    end = bj.replace(hour=12 if bj.hour < 12 else 18, minute=0, second=0, microsecond=0)
    return end.astimezone(timezone.utc)
