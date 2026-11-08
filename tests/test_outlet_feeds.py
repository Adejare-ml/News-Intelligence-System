"""Direct outlet RSS feeds as an ingestion source.

Google News only surfaces what its search ranks; the outlets' own feeds
carry every story they publish. Fixture feeds only: no network.
"""
import logging
from pathlib import Path

import pytest

from backend.app.services import ingestion
from backend.app.services.ingestion import NewsIngestionService, matches_search_topics

FIXTURE = (Path(__file__).parent / "fixtures" / "outlet_feed.xml").read_bytes()


class _Response:
    def __init__(self, content, status=200):
        self.content = content
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise ingestion.requests.HTTPError(f"HTTP {self.status_code}")


@pytest.fixture
def fake_http(monkeypatch):
    requested = []

    def get(url, **kwargs):
        requested.append(url)
        if "nairametrics" in url:
            return _Response(b"", status=503)
        return _Response(FIXTURE)

    monkeypatch.setattr(ingestion, "http_get_with_retry", get)
    return requested


def test_the_four_outlet_feeds_are_configured():
    assert NewsIngestionService.OUTLET_FEEDS == {
        "BusinessDay": "https://businessday.ng/feed/",
        "Premium Times": "https://www.premiumtimesng.com/feed",
        "Nairametrics": "https://nairametrics.com/feed/",
        "TheCable": "https://www.thecable.ng/feed",
    }


def test_outlet_feeds_keep_on_topic_items_once_and_name_the_outlet(fake_http):
    articles = NewsIngestionService.fetch_outlet_feeds()

    assert set(fake_http) == set(NewsIngestionService.OUTLET_FEEDS.values())
    # Every working feed serves the same fixture, so the shared link dedupe
    # leaves each story once, credited to the first outlet that carried it.
    urls = [a["url"] for a in articles]
    assert urls == [
        "https://outlet.example/2026/11/dangote-majority-stake/",
        "https://outlet.example/2026/11/cac-psc-register/",
    ]
    first = articles[0]
    assert first["source"] == "BusinessDay"
    assert first["published_at"] == "Fri, 06 Nov 2026 09:00:00 +0000"
    assert "controlling interest" in first["raw_text"]
    assert first["is_rss"] is True


def test_per_feed_counts_are_logged_and_a_broken_feed_is_survived(fake_http, caplog):
    with caplog.at_level(logging.INFO, logger=ingestion.logger.name):
        NewsIngestionService.fetch_outlet_feeds()
    text = caplog.text
    assert "BusinessDay: 2 on-topic of 4 entries" in text
    # The same fixture again: every on-topic story was already taken.
    assert "Premium Times: 0 on-topic of 4 entries" in text
    assert "Nairametrics" in text and "HTTPError" in text


@pytest.mark.parametrize("title, expected", [
    ("CBN fines three banks", True),
    ("Firm names new board of directors", True),
    ("Company announces merger with rival", True),
    ("Super Eagles win friendly in Uyo", False),
    # Whole words only: "audit" must not match "auditorium".
    ("New auditorium opens in Ibadan", False),
])
def test_topic_keywords_come_from_the_search_topics(title, expected):
    assert matches_search_topics(title) is expected
