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


def test_category_news_leaves_out_headlines_naming_an_unpublished_entity(tmp_path, monkeypatch):
    """The category pages and the emailed section pages read this file."""
    from backend.app.services import categories
    (tmp_path / "suppressed.json").write_text(json.dumps([{"name": "Atiku Abubakar"}]))
    payload = {"sections": {"politics": {
        "nigeria": [{"title": "Atiku Abubakar speaks", "url": "https://x/1"},
                    {"title": "Senate sits", "url": "https://x/2"}],
        "global": [{"title": "Summit", "url": "https://x/3", "source": "Alhaji Atiku Abubakar"}]}}}
    monkeypatch.setattr(categories, "build_category_news", lambda: payload)
    side_feeds.export_category_news(str(tmp_path))
    written = json.loads((tmp_path / "category_news.json").read_text())
    assert written["sections"]["politics"] == {"nigeria": [{"title": "Senate sits", "url": "https://x/2"}],
                                               "global": []}
