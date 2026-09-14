"""Entity dedupe, adapter retries and run observability (Package 17).

The dedupe cases mirror collision groups measured in the committed
companies.json (25 groups, e.g. NNPC / NNPC Limited / NNPC Ltd), so the
tests assert on the exact production shapes the fix exists for.
"""

import requests

from backend.app.db.excel_db import SHEETS_CONFIG, plan_header_migration
from backend.app.services import ingestion
from backend.app.services.ingestion import NewsIngestionService, http_get_with_retry
from run_pipeline import dedupe_entity_rows, entity_key


class TestEntityKey:
    def test_suffix_variants_collide(self):
        assert entity_key("NNPC") == entity_key("NNPC Limited") == entity_key("NNPC Ltd")
        assert entity_key("Unilever") == entity_key("Unilever Nigeria PLC")
        assert entity_key("Zenith Bank") == entity_key("Zenith Bank Plc")
        assert entity_key("United Bank for Africa") == entity_key("United Bank for Africa Plc")

    def test_distinct_entities_stay_distinct(self):
        assert entity_key("Zenith Bank") != entity_key("Access Bank")
        assert entity_key("Dangote Cement") != entity_key("Dangote Sugar")

    def test_all_noise_names_keep_their_surface_form(self):
        # A company literally named from noise words must not collide with
        # every other one via an empty key.
        assert entity_key("Nigeria Ltd") != ""
        assert entity_key("Nigeria Ltd") != entity_key("Holdings Plc")

    def test_punctuation_and_case_fold(self):
        assert entity_key("First-Bank") == entity_key("first bank")


class TestDedupeEntityRows:
    ROWS = [
        {"Company": "NNPC", "Mention Count": 5, "Last Seen": "2026-09-01"},
        {"Company": "NNPC Limited", "Mention Count": 9, "Last Seen": "2026-09-10"},
        {"Company": "NNPC Ltd", "Mention Count": 2, "Last Seen": "2026-09-12"},
        {"Company": "Access Bank", "Mention Count": 3, "Last Seen": "2026-09-11"},
    ]

    def test_variants_merge_with_summed_counts(self):
        out = dedupe_entity_rows(self.ROWS, ["Company"], count_key="Mention Count")
        assert len(out) == 2
        nnpc = out[0]
        assert nnpc["Mention Count"] == 16, "mentions were all of one entity"

    def test_longest_surface_form_becomes_the_label(self):
        out = dedupe_entity_rows(self.ROWS, ["Company"], count_key="Mention Count")
        assert out[0]["Company"] == "NNPC Limited"

    def test_people_two_field_key_still_separates_roles(self):
        rows = [
            {"Name": "Ada Obi", "Organization": "Acme Plc"},
            {"Name": "Ada Obi", "Organization": "Beta Ltd"},
            {"Name": "Ada Obi", "Organization": "Acme"},  # suffix variant of row 1
        ]
        out = dedupe_entity_rows(rows, ["Name", "Organization"])
        assert len(out) == 2


class TestHttpGetWithRetry:
    class FakeResponse:
        def __init__(self, status_code, headers=None):
            self.status_code = status_code
            self.headers = headers or {}

    def test_connection_errors_retry_then_succeed(self, monkeypatch):
        monkeypatch.setattr("time.sleep", lambda s: None)
        calls = {"n": 0}

        def flaky_get(url, **kwargs):
            calls["n"] += 1
            if calls["n"] < 3:
                raise requests.ConnectionError("reset")
            return self.FakeResponse(200)
        monkeypatch.setattr(ingestion.requests, "get", flaky_get)
        assert http_get_with_retry("https://x.test").status_code == 200
        assert calls["n"] == 3

    def test_429_retries_and_honours_retry_after(self, monkeypatch):
        waits = []
        monkeypatch.setattr("time.sleep", lambda s: waits.append(s))
        responses = [self.FakeResponse(429, {"Retry-After": "7"}), self.FakeResponse(200)]
        monkeypatch.setattr(ingestion.requests, "get", lambda url, **k: responses.pop(0))
        assert http_get_with_retry("https://x.test").status_code == 200
        assert waits and 7.0 <= waits[0] <= 7.5, "Retry-After seconds must be honoured"

    def test_non_retryable_status_returns_immediately(self, monkeypatch):
        calls = {"n": 0}

        def get_404(url, **kwargs):
            calls["n"] += 1
            return self.FakeResponse(404)
        monkeypatch.setattr(ingestion.requests, "get", get_404)
        assert http_get_with_retry("https://x.test").status_code == 404
        assert calls["n"] == 1

    def test_exhausted_retries_raise(self, monkeypatch):
        monkeypatch.setattr("time.sleep", lambda s: None)

        def always_fail(url, **kwargs):
            raise requests.Timeout("slow")
        monkeypatch.setattr(ingestion.requests, "get", always_fail)
        try:
            http_get_with_retry("https://x.test", attempts=2)
            raise AssertionError("should have raised")
        except requests.Timeout:
            pass


class TestObservability:
    def test_daily_reports_schema_carries_the_funnel(self):
        cols = SHEETS_CONFIG["Daily Reports"]
        for col in ("Candidates", "Rejected", "Undated",
                    "Stubs", "Nigerian", "Fresh", "Distinct"):
            assert col in cols
        assert cols[-1] == "Content", "the big cell stays last"

    def test_header_migration_adds_the_new_columns(self):
        old = ["Date", "Total Articles", "High Risk", "Appointments", "Procurement",
               "Cascade Failures", "Run Seconds", "Generated", "Archive File", "Content"]
        plan = plan_header_migration(old, SHEETS_CONFIG["Daily Reports"])
        assert plan["needs_migration"]
        assert set(plan["added"]) == {"Candidates", "Rejected", "Undated",
                                      "Stubs", "Nigerian", "Fresh", "Distinct"}
        assert plan["removed"] == []

    def test_collect_all_records_the_funnel(self, monkeypatch):
        from datetime import datetime
        stamp = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")

        def fetch_rss(*a, **k):
            return [
                {"title": "Nigeria market update", "source": "s", "url": "https://e.test/1",
                 "raw_text": "Lagos", "published_at": stamp},
                {"title": "Undated Nigeria story", "source": "s", "url": "https://e.test/2",
                 "raw_text": "Abuja", "published_at": ""},
                {"title": "Home", "source": "CAC", "url": "https://e.test/3",
                 "raw_text": "", "published_at": stamp},  # navigation stub
            ]
        for attr in ("fetch_news_api", "fetch_gnews", "fetch_guardian_news", "fetch_newsdata_io"):
            monkeypatch.setattr(NewsIngestionService, attr, staticmethod(lambda *a, **k: []))
        monkeypatch.setattr(NewsIngestionService, "fetch_google_news_rss", staticmethod(fetch_rss))

        out = NewsIngestionService.collect_all()
        stats = NewsIngestionService.last_collect_stats
        assert stats["fetched"] == 3
        assert stats["stubs"] == 1
        assert stats["undated"] == 1
        assert stats["distinct"] == len(out) == 1

    def test_regulator_queries_present(self):
        joined = " ".join(NewsIngestionService.SEARCH_TOPICS.values())
        for term in ("Bureau of Public Procurement", "NDIC", "FCCPC", "NUPRC"):
            assert term in joined, term
