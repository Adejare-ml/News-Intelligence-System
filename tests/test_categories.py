"""Tests for backend/app/services/categories.py (reader-chosen categories)."""

from datetime import datetime

from backend.app.services import categories


def fake_fetch(url, source):
    region = "nigeria" if "gl=NG" in url else "global"
    return [{"title": f"{region} {url[-40:]}", "url": url, "source": source, "published": ""}]


def test_only_technology_and_politics_are_built():
    # Sports and Entertainment were cut; their feeds must not come back unnoticed.
    assert categories.CATEGORIES == ("technology", "politics")
    assert set(categories.CATEGORY_FEEDS) == set(categories.CATEGORIES)


def test_every_category_has_both_regions():
    for category in categories.CATEGORIES:
        assert set(categories.CATEGORY_FEEDS[category]) == {"nigeria", "global"}
        for region, urls in categories.CATEGORY_FEEDS[category].items():
            assert urls, (category, region)
            marker = "gl=NG" if region == "nigeria" else "gl=US"
            assert all(marker in u for u in urls), (category, region)


def test_payload_shape():
    payload = categories.build_category_news(fetch=fake_fetch, now=datetime(2026, 11, 6, 7, 5))
    assert payload["generated"] == "2026-11-06 07:05:00"
    assert payload["regions"] == ["nigeria", "global"]
    assert list(payload["sections"]) == list(categories.CATEGORIES)
    assert payload["labels"] == {"technology": "Technology", "politics": "Politics"}
    for regions in payload["sections"].values():
        assert regions["nigeria"][0]["title"].startswith("nigeria")
        assert regions["global"][0]["title"].startswith("global")
    assert categories.has_headlines(payload)


def test_dead_feeds_give_empty_sections_not_errors():
    payload = categories.build_category_news(fetch=lambda url, source: [])
    assert all(r == {"nigeria": [], "global": []} for r in payload["sections"].values())
    assert not categories.has_headlines(payload)


def test_sections_are_capped():
    many = [{"title": f"t{i}", "url": f"https://x/{i}"} for i in range(30)]
    payload = categories.build_category_news(cap=3, fetch=lambda url, source: many)
    assert len(payload["sections"]["technology"]["global"]) == 3
