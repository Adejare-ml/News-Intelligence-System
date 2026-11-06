"""Tests for backend/app/pipeline/side_feeds.py."""

import json

from backend.app.pipeline import side_feeds


def test_one_failing_feed_does_not_stop_the_others(tmp_path):
    ran = []

    def boom(data_dir):
        raise RuntimeError("down")

    def ok(data_dir):
        ran.append(data_dir)

    side_feeds.export_side_feeds(str(tmp_path), {"a": boom, "b": ok})
    assert ran == [str(tmp_path)]


def test_empty_category_news_keeps_the_previous_file(tmp_path, monkeypatch):
    from backend.app.services import categories
    (tmp_path / "category_news.json").write_text('{"old": true}')
    monkeypatch.setattr(categories, "build_category_news",
                        lambda: {"sections": {"sports": {"nigeria": [], "global": []}}})
    side_feeds.export_category_news(str(tmp_path))
    assert json.loads((tmp_path / "category_news.json").read_text()) == {"old": True}


def test_category_news_is_written_when_any_section_has_headlines(tmp_path, monkeypatch):
    from backend.app.services import categories
    payload = {"sections": {"sports": {"nigeria": [{"title": "t", "url": "https://x"}], "global": []}}}
    monkeypatch.setattr(categories, "build_category_news", lambda: payload)
    side_feeds.export_category_news(str(tmp_path))
    assert json.loads((tmp_path / "category_news.json").read_text()) == payload


def test_every_side_feed_is_registered():
    assert "Category news" in side_feeds.SIDE_FEEDS
    assert len(side_feeds.SIDE_FEEDS) == 7
