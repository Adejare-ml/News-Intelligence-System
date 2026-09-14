"""Tests for backend/app/services/tech_news.py (Package 14).

All network is stubbed -- the sandbox has none, and the module's whole
contract is that a dead feed shrinks a section instead of raising.
"""

from backend.app.services import tech_news


ENTRIES = [
    {"title": "Anthropic ships a new model", "link": "https://p.test/a",
     "source": {"title": "TechDesk"}, "published": "Sat, 13 Sep 2026 10:00:00 GMT"},
    {"title": "OpenAI &amp; partners announce…", "link": "https://p.test/b"},
    # Junk shapes that must be dropped, not rendered as blanks:
    {"title": "", "link": "https://p.test/c"},
    {"title": "No link at all"},
    {"title": "javascript scheme", "link": "javascript:alert(1)"},
]


class TestParseFeedEntries:
    def test_parses_titles_links_and_sources(self):
        items = tech_news.parse_feed_entries(ENTRIES, "Google News")
        assert len(items) == 2
        assert items[0]["source"] == "TechDesk"
        assert items[1]["source"] == "Google News", "fallback source fills the gap"

    def test_unescapes_html_entities(self):
        items = tech_news.parse_feed_entries(ENTRIES, "x")
        assert items[1]["title"].startswith("OpenAI & partners")

    def test_non_http_links_are_dropped(self):
        urls = [i["url"] for i in tech_news.parse_feed_entries(ENTRIES, "x")]
        assert all(u.startswith("https://") for u in urls)

    def test_empty_input_is_safe(self):
        assert tech_news.parse_feed_entries([], "x") == []
        assert tech_news.parse_feed_entries(None, "x") == []


class TestDedupeItems:
    def test_dedupes_by_url_and_casefolded_title(self):
        items = [
            {"title": "Same Story", "url": "https://p.test/1"},
            {"title": "same story", "url": "https://p.test/2"},   # title dupe
            {"title": "Other", "url": "https://p.test/1"},        # url dupe
            {"title": "Kept", "url": "https://p.test/3"},
        ]
        out = tech_news.dedupe_items(items)
        assert [i["title"] for i in out] == ["Same Story", "Kept"]

    def test_cap_is_enforced(self):
        many = [{"title": f"T{i}", "url": f"https://p.test/{i}"} for i in range(40)]
        assert len(tech_news.dedupe_items(many)) == tech_news.SECTION_CAP
        assert len(tech_news.dedupe_items(many, cap=3)) == 3


class TestBuildTechNews:
    def test_sections_are_fetched_merged_and_capped(self, monkeypatch):
        def fake_fetch(url, fallback):
            return [{"title": f"From {url[:40]}", "url": "https://p.test/" + str(hash(url) % 10 ** 8),
                     "source": fallback, "published": ""}]
        monkeypatch.setattr(tech_news, "_fetch_feed", fake_fetch)
        payload = tech_news.build_tech_news()
        assert set(payload) == {"generated", "ai", "dev"}
        assert len(payload["ai"]) == len(tech_news.SECTIONS["ai"])
        assert len(payload["dev"]) == len(tech_news.SECTIONS["dev"])

    def test_a_dead_feed_shrinks_the_section_instead_of_raising(self, monkeypatch):
        def boom(*a, **k):
            raise OSError("connection refused")
        monkeypatch.setattr(tech_news.requests, "get", boom)
        payload = tech_news.build_tech_news()
        assert payload["ai"] == []
        assert payload["dev"] == []

    def test_http_error_is_swallowed_per_feed(self, monkeypatch):
        class FakeResponse:
            status_code = 503
            content = b""
            def raise_for_status(self):
                raise tech_news.requests.HTTPError("503")
        monkeypatch.setattr(tech_news.requests, "get", lambda *a, **k: FakeResponse())
        assert tech_news._fetch_feed("https://x.test/rss", "x") == []
