"""
Article images are a garnish: every failure must degrade to "no image",
never to a broken URL, a Google logo, or a failed export.
"""
from types import SimpleNamespace

from backend.app.services import images


class TestCleanImageUrl:
    def test_accepts_absolute_https(self):
        assert images.clean_image_url("https://cdn.example.com/a.jpg") == "https://cdn.example.com/a.jpg"

    def test_resolves_relative_against_page(self):
        assert images.clean_image_url("/img/a.jpg", "https://punchng.com/story/") == "https://punchng.com/img/a.jpg"

    def test_protocol_relative_becomes_https(self):
        assert images.clean_image_url("//cdn.example.com/a.jpg") == "https://cdn.example.com/a.jpg"

    def test_rejects_data_javascript_and_junk(self):
        for bad in ("data:image/png;base64,AAAA", "javascript:alert(1)", "", None, "x" * 3000):
            assert images.clean_image_url(bad) == ""


class TestExtractOgImage:
    def test_prefers_og_image(self):
        html = ('<html><head><meta name="twitter:image" content="https://t.example/x.jpg">'
                '<meta property="og:image" content="https://o.example/y.jpg"></head></html>')
        assert images.extract_og_image(html) == "https://o.example/y.jpg"

    def test_falls_back_to_twitter_image(self):
        html = '<meta name="twitter:image" content="https://t.example/x.jpg">'
        assert images.extract_og_image(html) == "https://t.example/x.jpg"

    def test_no_meta_means_no_image(self):
        assert images.extract_og_image("<html><head><title>x</title></head></html>") == ""


class TestFeedEntry:
    def test_media_content(self):
        entry = SimpleNamespace(media_content=[{"url": "https://m.example/a.jpg"}])
        assert images.image_from_feed_entry(entry) == "https://m.example/a.jpg"

    def test_image_enclosure_link(self):
        entry = SimpleNamespace(links=[{"type": "image/jpeg", "href": "https://m.example/b.jpg"}])
        assert images.image_from_feed_entry(entry) == "https://m.example/b.jpg"

    def test_entry_without_media(self):
        assert images.image_from_feed_entry(SimpleNamespace()) == ""


class TestAttachImages:
    def test_google_news_links_are_never_fetched(self):
        calls = []
        rows = [{"URL": "https://news.google.com/rss/articles/abc"}]
        images.attach_images(rows, {}, fetch=lambda u: calls.append(u) or "x")
        assert calls == []
        assert rows[0]["Image"] == ""

    def test_cached_lookups_are_not_repeated(self):
        calls = []
        cache = {"https://punchng.com/a": "", "https://punchng.com/b": "https://i/b.jpg"}
        rows = [{"URL": "https://punchng.com/a"}, {"URL": "https://punchng.com/b"}]
        images.attach_images(rows, cache, fetch=lambda u: calls.append(u) or "")
        assert calls == []
        assert [r["Image"] for r in rows] == ["", "https://i/b.jpg"]

    def test_fetch_budget_is_respected(self):
        rows = [{"URL": f"https://punchng.com/{i}"} for i in range(5)]
        fetched = images.attach_images(rows, {}, fetch=lambda u: u + ".jpg", max_fetches=2)
        assert fetched == 2
        assert [bool(r["Image"]) for r in rows] == [True, True, False, False, False]

    def test_remember_never_blanks_a_found_image(self):
        cache = {}
        images.remember(cache, "https://a/1", "https://i/1.jpg")
        images.remember(cache, "https://a/1", "")
        assert cache["https://a/1"] == "https://i/1.jpg"


def test_cache_roundtrip_prunes_to_published(tmp_path):
    images.save_cache(str(tmp_path), {"https://a/1": "https://i/1.jpg", "https://a/old": ""},
                      keep_urls=["https://a/1"])
    assert images.load_cache(str(tmp_path)) == {"https://a/1": "https://i/1.jpg"}


def test_missing_cache_file_is_empty(tmp_path):
    assert images.load_cache(str(tmp_path)) == {}


def test_fetch_failure_is_no_image(monkeypatch):
    def boom(*a, **k):
        raise ConnectionError("https://secret.example/?key=abc")
    monkeypatch.setattr(images.requests, "get", boom)
    assert images.fetch_og_image("https://punchng.com/a") == ""
