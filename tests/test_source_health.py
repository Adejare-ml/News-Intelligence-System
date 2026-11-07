"""Source health: per-adapter fetch counts merged run over run into
data/source_health.json, so a feed that silently returns nothing is
noticed after three runs instead of never.
"""
import json

import run_pipeline as rp
from backend.app.pipeline.rows import merge_source_health, stale_sources
from backend.app.services.ingestion import NewsIngestionService

NOW = "2026-11-07 07:00:00"


class TestMergeSourceHealth:
    def test_first_sighting(self):
        out = merge_source_health(None, {"GNews": 12, "NewsAPI": 0}, NOW)
        assert out["generated"] == NOW
        assert out["sources"]["GNews"] == {"last_count": 12, "empty_runs": 0, "last_ok": NOW}
        assert out["sources"]["NewsAPI"] == {"last_count": 0, "empty_runs": 1, "last_ok": ""}

    def test_empty_runs_accumulate_and_reset(self):
        prev = {"generated": "x", "sources": {
            "GNews": {"last_count": 0, "empty_runs": 2, "last_ok": "2026-11-01 07:00:00"},
            "NewsAPI": {"last_count": 0, "empty_runs": 5, "last_ok": ""},
        }}
        out = merge_source_health(prev, {"GNews": 0, "NewsAPI": 7}, NOW)
        assert out["sources"]["GNews"] == {"last_count": 0, "empty_runs": 3,
                                           "last_ok": "2026-11-01 07:00:00"}
        assert out["sources"]["NewsAPI"] == {"last_count": 7, "empty_runs": 0, "last_ok": NOW}

    def test_sources_not_run_this_time_are_kept_as_they_were(self):
        prev = {"sources": {"Guardian": {"last_count": 3, "empty_runs": 0, "last_ok": "y"}}}
        out = merge_source_health(prev, {"GNews": 1}, NOW)
        assert out["sources"]["Guardian"] == {"last_count": 3, "empty_runs": 0, "last_ok": "y"}

    def test_a_malformed_previous_file_starts_over(self):
        out = merge_source_health({"sources": "junk"}, {"GNews": 1}, NOW)
        assert list(out["sources"]) == ["GNews"]

    def test_stale_sources(self):
        health = merge_source_health({"sources": {
            "GNews": {"last_count": 0, "empty_runs": 2, "last_ok": ""}}},
            {"GNews": 0, "NewsAPI": 0}, NOW)
        assert stale_sources(health) == ["GNews"]


class TestCollectRecordsCounts:
    def test_configured_adapters_are_counted(self, monkeypatch):
        def fetcher(n):
            return staticmethod(lambda *a, **k: [{"title": f"t{i}", "source": "s",
                                                  "url": f"u{i}"} for i in range(n)])
        monkeypatch.setattr(NewsIngestionService, "fetch_google_news_rss", fetcher(3))
        monkeypatch.setattr(NewsIngestionService, "fetch_news_api", fetcher(0))
        monkeypatch.setattr(NewsIngestionService, "fetch_gnews", fetcher(2))
        monkeypatch.setattr(NewsIngestionService, "fetch_guardian_news", fetcher(0))
        monkeypatch.setattr(NewsIngestionService, "fetch_newsdata_io", fetcher(0))
        from backend.app.core.config import settings
        monkeypatch.setattr(settings, "NEWSAPI_KEY", "k")
        monkeypatch.setattr(settings, "GNEWS_KEY", "k")
        monkeypatch.setattr(settings, "GUARDIAN_API_KEY", "")
        monkeypatch.setattr(settings, "NEWSDATA_KEY", "")
        monkeypatch.setattr(settings, "SEED_DEMO_ARTICLES", False)
        NewsIngestionService.collect_all()
        # Keyless adapters are not failing, they are off: not counted.
        assert NewsIngestionService.last_source_counts == {
            "Google News RSS": 3, "NewsAPI": 0, "GNews": 2}


class TestWriteSourceHealth:
    def test_merges_with_the_previous_file_and_flags_stale_feeds(self, tmp_path, monkeypatch):
        monkeypatch.setattr(rp, "DATA_DIR", str(tmp_path))
        summary = tmp_path / "summary.md"
        monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
        (tmp_path / "source_health.json").write_text(json.dumps({"sources": {
            "GNews": {"last_count": 0, "empty_runs": 2, "last_ok": ""}}}))
        rp.write_source_health({"GNews": 0, "NewsAPI": 4})
        health = json.loads((tmp_path / "source_health.json").read_text())
        assert health["sources"]["GNews"]["empty_runs"] == 3
        assert health["sources"]["NewsAPI"]["last_count"] == 4
        assert "GNews" in summary.read_text()
        assert "NewsAPI" not in summary.read_text()

    def test_no_summary_file_outside_actions(self, tmp_path, monkeypatch):
        monkeypatch.setattr(rp, "DATA_DIR", str(tmp_path))
        monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
        rp.write_source_health({"GNews": 0})
        assert json.loads((tmp_path / "source_health.json").read_text())["sources"]["GNews"]
