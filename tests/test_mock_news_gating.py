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
        real = [{"title": f"Real story {i}", "url": f"https://real.test/{i}",
                 "source": "Punch", "raw_text": "Dangote Cement Plc announced a "
                 "change of ownership in Lagos today.", "published_at": "2026-08-11T10:00:00"}
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
        monkeypatch.setattr(settings, "SEED_DEMO_ARTICLES", True)
        with caplog.at_level("WARNING"):
            result = NewsIngestionService.collect_all()

        assert any(a.get("is_synthetic") for a in result), (
            "SEED_DEMO_ARTICLES=true must still make the demo path available"
        )
        assert "SEED_DEMO_ARTICLES is on" in caplog.text


def test_explicit_seed_mode_still_generates():
    """run_pipeline --seed is a deliberate request and is unaffected."""
    articles = NewsIngestionService.generate_mock_news(5)
    assert len(articles) == 5
    assert all(a["source"] == SYNTHETIC_SOURCE for a in articles)
