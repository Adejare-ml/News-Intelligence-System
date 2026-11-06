"""Tests for backend/app/services/headlines.py (shared headline feeds)."""

import pytest

from backend.app.services import headlines


def test_search_url_uses_the_region_edition():
    ng = headlines.google_search_url("Super Eagles", "nigeria")
    gl = headlines.google_search_url("Super Eagles", "global")
    assert ng.startswith("https://news.google.com/rss/search?q=Super%20Eagles&")
    assert "gl=NG" in ng and "ceid=NG:en" in ng
    assert "gl=US" in gl


def test_topic_url_uses_the_region_edition():
    assert headlines.google_topic_url("SPORTS", "nigeria").endswith(
        "/topic/SPORTS?hl=en-NG&gl=NG&ceid=NG:en")


def test_unknown_region_is_rejected():
    with pytest.raises(ValueError):
        headlines.google_search_url("x", "mars")


def test_merged_section_merges_in_order_dedupes_and_caps():
    feeds = {
        "a": [{"title": "One", "url": "https://x/1"}, {"title": "Two", "url": "https://x/2"}],
        "b": [{"title": "one", "url": "https://y/1"}, {"title": "Three", "url": "https://x/3"}],
    }
    out = headlines.merged_section(["a", "b"], fetch=lambda url, src: feeds[url], cap=2)
    assert [i["title"] for i in out] == ["One", "Two"]
    out = headlines.merged_section(["a", "b"], fetch=lambda url, src: feeds[url], cap=10)
    assert [i["title"] for i in out] == ["One", "Two", "Three"]


def test_fallback_source_names_hacker_news():
    assert headlines.fallback_source_for("https://hnrss.org/frontpage") == "Hacker News"
    assert headlines.fallback_source_for("https://news.google.com/rss") == "Google News"


def test_fetch_feed_swallows_network_errors(monkeypatch):
    def boom(*a, **k):
        raise headlines.requests.ConnectionError("down")
    monkeypatch.setattr(headlines.requests, "get", boom)
    assert headlines.fetch_feed("https://x.test/rss", "x") == []
