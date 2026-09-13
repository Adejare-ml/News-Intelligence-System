"""
The Trending panel must only assert trends the articles substantiate, and
the weather export must degrade to nothing rather than to fabrication.

compute_trends is pure over the Articles rows this system already
publishes; the external social signal is sanitized to canonical reddit
permalinks so a post cannot smuggle an arbitrary URL onto the page.
"""
from datetime import datetime

import pytest

from backend.app.services.trends import compute_trends, fetch_reddit_nigeria
from backend.app.services.weather import build_weather_payload, describe_weather_code

NOW = datetime(2026, 9, 13, 12, 0, 0)


def _row(days_ago_time, title, status="Unread", category="Company"):
    return {"Time": days_ago_time, "Title": title, "Status": status, "Category": category}


class TestComputeTrends:
    def test_rising_needs_two_recent_mentions(self):
        rows = [
            _row("2026-09-12T10:00:00", "Dangote refinery expands output"),
            _row("2026-09-11T10:00:00", "Dangote refinery hits milestone"),
            _row("2026-09-10T10:00:00", "Lone story about GTCO"),
        ]
        out = compute_trends(rows, now=NOW)
        terms = [e["term"] for e in out["rising"]]
        assert "dangote" in terms
        assert "gtco" not in terms, "a single article is a story, not a trend"

    def test_windows_split_recent_vs_previous(self):
        rows = [
            _row("2026-09-12T10:00:00", "NNPC audit begins"),
            _row("2026-09-11T10:00:00", "NNPC audit widens"),
            _row("2026-09-03T10:00:00", "CBN policy shifts markets"),
            _row("2026-09-02T10:00:00", "CBN policy defended"),
            _row("2026-09-01T10:00:00", "CBN policy questioned"),
        ]
        out = compute_trends(rows, now=NOW, window_days=7)
        rising = {e["term"]: e for e in out["rising"]}
        falling = {e["term"]: e for e in out["falling"]}
        assert rising["nnpc"]["recent"] == 2 and rising["nnpc"]["previous"] == 0
        assert falling["cbn"]["previous"] == 3 and falling["cbn"]["recent"] == 0
        assert out["recent_articles"] == 2
        assert out["previous_articles"] == 3

    def test_filtered_and_undated_rows_are_excluded(self):
        rows = [
            _row("2026-09-12T10:00:00", "Junk junk junk", status="Filtered"),
            _row("2026-09-12T11:00:00", "Junk junk returns", status="Filtered"),
            _row("not a date", "Undated undated story"),
        ]
        out = compute_trends(rows, now=NOW)
        assert out["rising"] == []
        assert out["recent_articles"] == 0

    def test_bigrams_survive_and_stopwords_do_not(self):
        rows = [
            _row("2026-09-12T10:00:00", "Access Holdings acquires new unit"),
            _row("2026-09-11T10:00:00", "Access Holdings expands to Kenya"),
        ]
        out = compute_trends(rows, now=NOW)
        terms = [e["term"] for e in out["rising"]]
        assert "access holdings" in terms
        assert "the" not in terms and "new" not in terms

    def test_one_headline_counts_a_term_once(self):
        rows = [
            _row("2026-09-12T10:00:00", "Dangote Dangote Dangote"),
            _row("2026-09-11T10:00:00", "Dangote again"),
        ]
        out = compute_trends(rows, now=NOW)
        rising = {e["term"]: e for e in out["rising"]}
        assert rising["dangote"]["recent"] == 2

    def test_category_momentum(self):
        rows = [
            _row("2026-09-12T10:00:00", "A story", category="Legal"),
            _row("2026-09-03T10:00:00", "B story", category="Company"),
        ]
        cats = {c["category"]: c for c in compute_trends(rows, now=NOW)["categories"]}
        assert cats["Legal"]["recent"] == 1 and cats["Legal"]["previous"] == 0
        assert cats["Company"]["previous"] == 1

    def test_deterministic(self):
        rows = [_row("2026-09-12T10:00:00", "NNPC audit"), _row("2026-09-11T10:00:00", "NNPC audit two")]
        assert compute_trends(rows, now=NOW) == compute_trends(rows, now=NOW)

    def test_empty_input(self):
        out = compute_trends([], now=NOW)
        assert out["rising"] == [] and out["falling"] == [] and out["categories"] == []


class TestRedditSanitization:
    class _FakeResp:
        status_code = 200

        def __init__(self, children):
            self._children = children

        def json(self):
            return {"data": {"children": self._children}}

    def test_only_canonical_permalinks_survive(self, monkeypatch):
        import backend.app.services.trends as mod
        children = [
            {"data": {"title": "Real post", "score": 10, "num_comments": 3,
                      "permalink": "/r/Nigeria/comments/abc/real_post/"}},
            {"data": {"title": "Evil", "score": 99, "num_comments": 0,
                      "permalink": "https://evil.test/phish"}},
            {"data": {"title": "Sticky", "score": 5, "num_comments": 0, "stickied": True,
                      "permalink": "/r/Nigeria/comments/def/sticky/"}},
        ]
        monkeypatch.setattr(mod.requests, "get", lambda *a, **k: self._FakeResp(children))
        posts = fetch_reddit_nigeria()
        assert len(posts) == 1
        assert posts[0]["url"] == "https://www.reddit.com/r/Nigeria/comments/abc/real_post/"

    def test_network_failure_returns_empty(self, monkeypatch):
        import backend.app.services.trends as mod

        def boom(*a, **k):
            raise OSError("no network")
        monkeypatch.setattr(mod.requests, "get", boom)
        assert fetch_reddit_nigeria() == []


class TestWeather:
    def test_known_and_unknown_codes(self):
        assert describe_weather_code(95) == "Thunderstorm"
        assert describe_weather_code(0) == "Clear sky"
        assert describe_weather_code("weird") == "Unknown conditions"
        assert describe_weather_code(42) == "Unknown conditions"

    def test_payload_shape(self):
        payload = build_weather_payload([
            {"name": "Lagos", "data": {"current": {
                "temperature_2m": 29.4, "relative_humidity_2m": 84,
                "weather_code": 80, "wind_speed_10m": 12.3}}},
            {"name": "Abuja", "data": {"current": {}}},  # no temp -> dropped
        ])
        assert len(payload["cities"]) == 1
        city = payload["cities"][0]
        assert city["name"] == "Lagos"
        assert city["temp_c"] == 29.4
        assert city["description"] == "Rain showers"
        assert payload["source"] == "open-meteo.com"

    def test_no_usable_city_means_none_not_empty(self):
        assert build_weather_payload([]) is None
        assert build_weather_payload([{"name": "Lagos", "data": {}}]) is None
