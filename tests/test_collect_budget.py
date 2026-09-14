"""The collect_all wall-clock budget (Package 13).

Each adapter's HTTP calls carry their own timeouts, but Google News RSS
issues one request per query term -- on a degraded network the fetch phase
alone could consume most of the run's 90-minute ceiling. The budget is
checked between adapters, so a slow start skips the remaining fetchers
and the run continues with what was already collected.

Time is stubbed: no sleeping, no network.
"""

import pytest

from backend.app.services.ingestion import NewsIngestionService


@pytest.fixture
def stubbed_adapters(monkeypatch):
    """Every fetcher returns one dated, Nigerian, distinct article and
    records that it ran; the clock is advanced manually by the test."""
    calls = []

    def make_fetcher(name):
        def fetch(*args, **kwargs):
            calls.append(name)
            return [{
                "title": f"Nigeria market update {name}",
                "source": name,
                "url": f"https://example.com/{name}",
                "raw_text": f"Lagos coverage from {name}",
                "published_at": __import__("datetime").datetime.utcnow()
                    .strftime("%Y-%m-%dT%H:%M:%S"),
            }]
        return fetch

    for attr, name in [
        ("fetch_google_news_rss", "rss"),
        ("fetch_news_api", "newsapi"),
        ("fetch_gnews", "gnews"),
        ("fetch_guardian_news", "guardian"),
        ("fetch_newsdata_io", "newsdata"),
    ]:
        monkeypatch.setattr(NewsIngestionService, attr,
                            staticmethod(make_fetcher(name)))
    return calls


def _stub_clock(monkeypatch, per_adapter_seconds):
    """time.monotonic() advances by per_adapter_seconds on every call."""
    import backend.app.services.ingestion  # noqa: F401 - module under test
    import time
    state = {"now": 0.0}

    def monotonic():
        state["now"] += per_adapter_seconds
        return state["now"]
    monkeypatch.setattr(time, "monotonic", monotonic)


class TestCollectBudget:
    def test_all_adapters_run_inside_the_budget(self, stubbed_adapters, monkeypatch):
        _stub_clock(monkeypatch, per_adapter_seconds=1.0)
        articles = NewsIngestionService.collect_all()
        assert stubbed_adapters == ["rss", "newsapi", "gnews", "guardian", "newsdata"]
        assert len(articles) == 5

    def test_exhausted_budget_skips_the_remaining_adapters(self, stubbed_adapters, monkeypatch):
        # Each clock reading jumps past the whole budget, so only the first
        # adapter (checked before the clock has advanced past it) runs.
        _stub_clock(monkeypatch,
                    per_adapter_seconds=NewsIngestionService.COLLECT_BUDGET_SECONDS)
        articles = NewsIngestionService.collect_all()
        assert stubbed_adapters == ["rss"], "later adapters must be skipped"
        # What was already fetched is still filtered and returned, not lost.
        assert len(articles) == 1

    def test_budget_is_generous_enough_for_real_runs(self):
        # Guard against an accidental edit making the budget meaningless.
        assert NewsIngestionService.COLLECT_BUDGET_SECONDS >= 300
