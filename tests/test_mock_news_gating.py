"""
Synthetic articles must never be attributed to real newspapers, and must never
enter a production cycle unasked.

collect_all used to pad any cycle returning fewer than ten articles with 25
generated stories -- which fires exactly when the fetchers are failing -- and
those stories were bylined "Reuters Intelligence", "Bloomberg Business",
"Financial Times News" and "Wall Street Journal", with URLs on those
newspapers' own domains. Nothing marked them as synthetic, so they were
analysed, stored, counted in the KPIs and folded into the executive brief
indistinguishably from real reporting.
"""
from datetime import datetime, timedelta
from urllib.parse import urlparse

import pytest

from backend.app.core.config import settings
from backend.app.services.ingestion import NewsIngestionService, SYNTHETIC_SOURCE
from backend.app.services.relevance import NEWS_OUTLET_MARKERS


@pytest.fixture
def sample():
    # Enough to be confident the random choices cannot surface an old name.
    return NewsIngestionService.generate_mock_news(60)


class TestNoFalseAttribution:
    def test_no_real_outlet_appears_in_any_source(self, sample):
        """
        Checked against the outlet list in services.relevance, which already
        names Reuters, Bloomberg, BBC, CNN and the Nigerian mastheads -- so this
        keeps working if that list grows.
        """
        for article in sample:
            source = (article.get("source") or "").lower()
            for marker in NEWS_OUTLET_MARKERS:
                assert marker not in source, (
                    f"synthetic article bylined to {article['source']!r}, which "
                    f"contains the real outlet marker {marker!r}"
                )

    def test_no_real_outlet_appears_in_any_url(self, sample):
        for article in sample:
            url = (article.get("url") or "").lower()
            for marker in NEWS_OUTLET_MARKERS:
                assert marker.replace(" ", "") not in url, (
                    f"synthetic URL {url!r} points at a real outlet domain"
                )

    def test_every_url_is_on_a_reserved_unresolvable_domain(self, sample):
        """RFC 2606 reserves .invalid; a generated link must not resolve."""
        for article in sample:
            host = urlparse(article["url"]).netloc
            assert host.endswith(".invalid"), f"{host!r} is not a reserved domain"

    def test_the_source_says_what_the_row_is(self, sample):
        for article in sample:
            assert article["source"] == SYNTHETIC_SOURCE
        assert "synthetic" in SYNTHETIC_SOURCE.lower()

    def test_records_carry_an_explicit_synthetic_flag(self, sample):
        for article in sample:
            assert article.get("is_synthetic") is True


class TestProductionGating:
    """A thin cycle must not be padded unless someone asked for it."""

    @pytest.fixture
    def thin_fetchers(self, monkeypatch):
        """Every adapter returns almost nothing, as in a real outage."""
        # Relative to now, not a fixed date: collect_all's 48h freshness gate
        # would otherwise start silently dropping these as the fixture ages,
        # leaving every assertion below running against a degenerate list.
        recent = (datetime.now() - timedelta(hours=2)).isoformat()
        real = [{"title": f"Real story {i}", "url": f"https://real.test/{i}",
                 "source": "Punch", "raw_text": "Dangote Cement Plc announced a "
                 "change of ownership in Lagos today.", "published_at": recent}
                for i in range(3)]
        monkeypatch.setattr(NewsIngestionService, "fetch_google_news_rss",
                            classmethod(lambda cls: list(real)))
        for name in ("fetch_news_api", "fetch_gnews", "fetch_guardian_news",
                     "fetch_newsdata_io"):
            monkeypatch.setattr(NewsIngestionService, name, staticmethod(lambda: []))
        return real

    def test_does_not_pad_by_default(self, thin_fetchers, monkeypatch, caplog):
        monkeypatch.setattr(settings, "SEED_DEMO_ARTICLES", False)
        with caplog.at_level("WARNING"):
            result = NewsIngestionService.collect_all()

        assert not any(a.get("is_synthetic") for a in result), (
            "a default production cycle must never contain invented articles"
        )
        assert any(SYNTHETIC_SOURCE == a.get("source") for a in result) is False
        assert "Continuing with what is real" in caplog.text

    def test_thin_cycle_is_logged_rather_than_hidden(self, thin_fetchers, monkeypatch, caplog):
        """Silence would be its own failure -- a broken fetcher must be visible."""
        monkeypatch.setattr(settings, "SEED_DEMO_ARTICLES", False)
        with caplog.at_level("WARNING"):
            NewsIngestionService.collect_all()
        assert "Check the source adapters and API keys" in caplog.text

    def test_opting_in_restores_the_demo_behaviour(self, thin_fetchers, monkeypatch, caplog):
        """
        This tests the wiring -- that SEED_DEMO_ARTICLES=true makes collect_all
        call generate_mock_news and let its output through -- not whether a
        randomly generated article happens to survive collect_all's Nigeria and
        48h filters. That was the bug: real generate_mock_news() output was
        flaky against those filters (only ~2 of 6 templates mention Nigeria at
        all, and pub dates spread over 10 days vs. a 48h window), so this test
        failed about one run in four despite the gating logic being correct.
        generate_mock_news's own output shape (no real outlet, .invalid URLs,
        is_synthetic=True) is already exhaustively covered by
        TestNoFalseAttribution above; stubbing it here isolates what this test
        is actually responsible for.
        """
        now_iso = datetime.now().isoformat()

        def fake_generate_mock_news(cls, count):
            return [{
                "title": f"Synthetic Nigeria story {i}",
                "url": f"https://sample.example.invalid/{i}",
                "source": SYNTHETIC_SOURCE,
                "published_at": now_iso,
                "raw_text": "Synthetic content mentioning Nigeria and Lagos.",
                "is_rss": False,
                "is_synthetic": True,
                "mock_category": "Government",
                "mock_event_type": "Appointment",
            } for i in range(count)]

        monkeypatch.setattr(NewsIngestionService, "generate_mock_news",
                            classmethod(fake_generate_mock_news))
        monkeypatch.setattr(settings, "SEED_DEMO_ARTICLES", True)
        with caplog.at_level("WARNING"):
            result = NewsIngestionService.collect_all()

        assert any(a.get("is_synthetic") for a in result), (
            "SEED_DEMO_ARTICLES=true must still make the demo path available"
        )
        assert "SEED_DEMO_ARTICLES is on" in caplog.text


class TestThinIsAssessedAfterFiltering:
    def test_junk_heavy_cycle_is_still_flagged_as_thin(self, monkeypatch, caplog):
        """
        The thin-cycle check used to run on the raw fetch count, before the
        stub/Nigeria/48h/dedup filters that define what is publishable -- so
        forty junk feed entries masked a cycle that actually yielded two
        stories, and neither the warning nor the opt-in padding ever fired.
        """
        recent = (datetime.now() - timedelta(hours=2)).isoformat()
        junk = [{"title": f"Global markets update {i}", "url": f"https://elsewhere.test/{i}",
                 "source": "Wire", "raw_text": "European equities drifted sideways today.",
                 "published_at": recent}
                for i in range(40)]
        # Distinct titles: near-identical ones would be fuzzy-deduplicated
        # into a single story and undercount the survivors.
        real = [
            {"title": "Dangote Cement Plc announces ownership change",
             "url": "https://real.test/1", "source": "Punch",
             "raw_text": "Dangote Cement Plc announced a change of ownership "
             "in Lagos today.", "published_at": recent},
            {"title": "EFCC opens procurement probe at power ministry",
             "url": "https://real.test/2", "source": "Punch",
             "raw_text": "The EFCC in Abuja opened a procurement investigation "
             "today.", "published_at": recent},
        ]
        monkeypatch.setattr(NewsIngestionService, "fetch_google_news_rss",
                            classmethod(lambda cls: junk + real))
        for name in ("fetch_news_api", "fetch_gnews", "fetch_guardian_news",
                     "fetch_newsdata_io"):
            monkeypatch.setattr(NewsIngestionService, name, staticmethod(lambda: []))
        monkeypatch.setattr(settings, "SEED_DEMO_ARTICLES", False)

        with caplog.at_level("WARNING"):
            result = NewsIngestionService.collect_all()

        assert len(result) == 2
        assert "Only 2 publishable article(s)" in caplog.text
        assert not any(a.get("is_synthetic") for a in result)


def test_explicit_seed_mode_still_generates():
    """run_pipeline --seed is a deliberate request and is unaffected."""
    articles = NewsIngestionService.generate_mock_news(5)
    assert len(articles) == 5
    assert all(a["source"] == SYNTHETIC_SOURCE for a in articles)
