"""
An unreadable publication date must not become "now".

parse_feed_date used to fall back to datetime.now() on every failure. Its only
caller is the 48-hour freshness gate, and now() is always inside a window
ending at now() -- so every article with a missing or unrecognised date passed
the filter unconditionally, then sorted to the top of a newest-first feed. An
article of unknown age was presented as breaking news.
"""
from datetime import datetime, timedelta

import pytest

from backend.app.services.ingestion import parse_feed_date


@pytest.mark.parametrize("value,expected", [
    ("2026-08-09T10:00:00", datetime(2026, 8, 9, 10, 0, 0)),
    ("2026-08-09 10:00:00", datetime(2026, 8, 9, 10, 0, 0)),
    ("2026-08-09T10:00:00Z", datetime(2026, 8, 9, 10, 0, 0)),
    ("2026-08-09T10:00:00.123456", datetime(2026, 8, 9, 10, 0, 0)),
])
def test_recognised_formats_still_parse(value, expected):
    assert parse_feed_date(value) == expected


def test_rfc822_with_numeric_offset_parses():
    """The email.utils fallback, which real RSS feeds rely on."""
    parsed = parse_feed_date("Sat, 09 Aug 2026 10:00:00 +0100")
    assert parsed is not None
    assert parsed.date() == datetime(2026, 8, 9).date()


@pytest.mark.parametrize("value", [
    None,
    "",
    "   ",
    "09/08/2026",          # real format, not one this parser knows
    "not a date at all",
    "yesterday",
])
def test_unreadable_dates_return_none_not_now(value):
    assert parse_feed_date(value) is None


def test_undated_articles_no_longer_pass_the_48h_gate():
    """
    The regression itself. Under the old fallback every one of these returned
    now() and sat inside the window; the gate could not exclude anything it
    could not read.
    """
    limit = datetime.now() - timedelta(hours=48)

    for unreadable in (None, "", "09/08/2026", "garbage"):
        parsed = parse_feed_date(unreadable)
        assert parsed is None, f"{unreadable!r} must not resolve to a timestamp"

    # A genuinely fresh article still passes, and a genuinely old one does not,
    # so the gate has not simply been broken shut.
    fresh = parse_feed_date((datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S"))
    stale = parse_feed_date("2026-06-01T10:00:00")
    assert fresh is not None and fresh >= limit
    assert stale is not None and stale < limit
