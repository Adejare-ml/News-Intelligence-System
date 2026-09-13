"""
Exported data must be bounded, deduplicated, and free of the reporting
outlets it came from.

Pinned findings: reports.json was 90% embedded markdown (fetched on every
page load, growing ~3.4MB/year) while identical bytes sat in
data/archives/; the graph's dedupe set was case-sensitive while node ids
are not, shipping duplicate ids the frontend has to patch around; outlets
and page furniture from ~1,100 legacy rows sailed into companies.json and
the graph; and eval capture banked 85-char RSS blurbs (82% under the
validator's floor) plus duplicate URLs.
"""
import json
import os

import pytest

import run_pipeline as rp
from backend.app.db.excel_db import SheetsDatabase
from run_pipeline import dedupe_entity_rows, slim_report_rows, top_rows

TEST_DB_PATH = "tests/test_data_quality.xlsx"


class TestSlimReportRows:
    def test_strips_content_only_when_an_archive_file_exists(self):
        rows = [
            {"Date": "2026-09-01", "Content": "# big markdown", "Archive File": "report_20260901_070000.md"},
            {"Date": "2026-07-01", "Content": "# legacy, only copy", "Archive File": ""},
        ]
        out = slim_report_rows(rows)
        assert out[0]["Content"] == ""
        assert out[1]["Content"] == "# legacy, only copy"

    def test_caps_to_the_newest_rows(self):
        rows = [{"Date": f"2026-01-{i:02d}", "Content": "", "Archive File": ""} for i in range(1, 31)]
        out = slim_report_rows(rows, keep=10)
        assert len(out) == 10
        assert out[0]["Date"] == "2026-01-21"

    def test_does_not_mutate_the_input(self):
        rows = [{"Date": "2026-09-01", "Content": "kept", "Archive File": "report_x.md"}]
        slim_report_rows(rows)
        assert rows[0]["Content"] == "kept"


class TestDedupeEntityRows:
    def test_company_dedupe_is_case_insensitive_and_keeps_max_count(self):
        rows = [
            {"Company": "The Guardian Nigeria News", "Mention Count": 2},
            {"Company": "EFCC", "Mention Count": 3},
            {"Company": "efcc", "Mention Count": 9},
        ]
        out = dedupe_entity_rows(rows, ["Company"], count_key="Mention Count")
        assert len(out) == 2
        efcc = [r for r in out if r["Company"].lower() == "efcc"][0]
        assert efcc["Mention Count"] == 9

    def test_people_dedupe_keys_on_name_and_org_keeping_the_newest(self):
        rows = [
            {"Name": "Tinubu", "Organization": "FGN", "Date": "2026-01-01"},
            {"Name": "tinubu", "Organization": "fgn", "Date": "2026-09-01"},
            {"Name": "Tinubu", "Organization": "APC", "Date": "2026-02-02"},
        ]
        out = dedupe_entity_rows(rows, ["Name", "Organization"])
        assert len(out) == 2
        assert out[0]["Date"] == "2026-09-01"

    def test_blank_keys_are_dropped(self):
        assert dedupe_entity_rows([{"Company": "  "}], ["Company"]) == []


class TestTopRows:
    def test_ranks_by_count_then_date(self):
        rows = [
            {"Company": "Old", "Mention Count": 1, "Last Seen": "2026-01-01"},
            {"Company": "Hot", "Mention Count": 9, "Last Seen": "2026-05-01"},
            {"Company": "Recent", "Mention Count": 1, "Last Seen": "2026-09-01"},
        ]
        out = top_rows(rows, 2, count_key="Mention Count", date_key="Last Seen")
        assert [r["Company"] for r in out] == ["Hot", "Recent"]

    def test_date_only_ranking(self):
        rows = [{"Date": "2026-01-01"}, {"Date": "2026-09-09"}, {"Date": "2026-05-05"}]
        assert top_rows(rows, 2, date_key="Date")[0]["Date"] == "2026-09-09"

    def test_garbage_counts_rank_last_not_crash(self):
        rows = [{"Mention Count": "junk"}, {"Mention Count": 4}]
        assert top_rows(rows, 1, count_key="Mention Count")[0]["Mention Count"] == 4


class TestEvalCapture:
    @pytest.fixture
    def corpus(self, tmp_path, monkeypatch):
        monkeypatch.setattr(rp, "EVAL_CORPUS_DIR", str(tmp_path))
        monkeypatch.setattr(rp, "EVAL_CAPTURE_RATE", 1)  # always sample
        return tmp_path

    def _lines(self, corpus):
        files = list(corpus.glob("*.jsonl"))
        if not files:
            return []
        return [json.loads(l) for l in files[0].read_text().splitlines()]

    def test_blurbs_below_the_floor_are_not_banked(self, corpus):
        rp.capture_eval_input("t", "too short to label", "https://x.test/1", "Punch")
        assert self._lines(corpus) == []

    def test_full_bodies_are_banked_once_per_url(self, corpus):
        body = "Dangote Cement announced a change of ownership. " * 10
        rp.capture_eval_input("t", body, "https://x.test/1", "Punch")
        rp.capture_eval_input("t again", body, "https://x.test/1", "Punch")
        rp.capture_eval_input("other", body, "https://x.test/2", "Punch")
        urls = [r["url"] for r in self._lines(corpus)]
        assert urls == ["https://x.test/1", "https://x.test/2"]


class TestExportEndToEnd:
    """Export against a real local workbook: outlets filtered, node ids
    unique despite case-variant rows, reports.json slimmed."""

    @pytest.fixture
    def exported(self, tmp_path, monkeypatch):
        if os.path.exists(TEST_DB_PATH):
            os.remove(TEST_DB_PATH)
        d = SheetsDatabase()
        d.use_local = True
        d.local_path = TEST_DB_PATH
        d._cache = {}
        d._init_db()

        d._append_row("Companies", {"Company": "The Economic and Financial Crimes Commission",
                                    "Mention Count": 2, "Last Seen": "2026-09-01", "Risk Level": "Low"})
        d._append_row("Companies", {"Company": "the Economic and Financial Crimes Commission",
                                    "Mention Count": 5, "Last Seen": "2026-09-02", "Risk Level": "Low"})
        d._append_row("Companies", {"Company": "Premium Times Nigeria", "Mention Count": 8,
                                    "Last Seen": "2026-09-02", "Risk Level": "Low"})
        d._append_row("Companies", {"Company": "Dangote Cement Plc", "Mention Count": 4,
                                    "Last Seen": "2026-09-02", "Risk Level": "High"})
        d._append_row("Daily Reports", {"Date": "2026-09-01", "Total Articles": 1, "High Risk": 0,
                                        "Appointments": 0, "Procurement": 0,
                                        "Generated": "2026-09-01 07:00:00",
                                        "Archive File": "report_20260901_070000.md",
                                        "Content": "# should be stripped"})

        out_dir = tmp_path / "data"
        out_dir.mkdir()
        (out_dir / "archives").mkdir()
        monkeypatch.setattr(rp, "db", d)
        monkeypatch.setattr(rp, "DATA_DIR", str(out_dir))
        # The export's best-effort context-signal fetches must not reach
        # the network from a test run.
        import backend.app.services.trends as trends_mod
        import backend.app.services.weather as weather_mod
        monkeypatch.setattr(weather_mod, "fetch_weather", lambda *a, **k: None)
        monkeypatch.setattr(trends_mod, "fetch_reddit_nigeria", lambda *a, **k: [])
        rp.export_static_json_database()
        yield out_dir
        if os.path.exists(TEST_DB_PATH):
            os.remove(TEST_DB_PATH)

    def test_outlets_do_not_ship_as_companies(self, exported):
        companies = json.loads((exported / "companies.json").read_text())
        names = [c["Company"] for c in companies]
        assert "Premium Times Nigeria" not in names
        assert "Dangote Cement Plc" in names

    def test_case_variants_collapse_to_one_row_and_one_node(self, exported):
        companies = json.loads((exported / "companies.json").read_text())
        efcc = [c for c in companies if "Economic and Financial" in c["Company"]]
        assert len(efcc) == 1
        assert int(float(str(efcc[0]["Mention Count"]))) == 5

        graph = json.loads((exported / "graph.json").read_text())
        ids = [n["id"] for n in graph["nodes"]]
        assert len(ids) == len(set(ids)), "duplicate node ids shipped"

    def test_reports_json_is_slimmed(self, exported):
        reports = json.loads((exported / "reports.json").read_text())
        assert reports[-1]["Content"] == ""
        assert reports[-1]["Archive File"] == "report_20260901_070000.md"
