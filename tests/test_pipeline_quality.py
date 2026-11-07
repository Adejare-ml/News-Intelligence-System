"""Pipeline data quality: missing cells stored and exported as blanks,
the procurement rollup counted after dedupe, and the export refusing to
publish an empty site over a full one.
"""
import json

import pytest

import run_pipeline as rp
from backend.app.db.excel_db import SheetsDatabase
from backend.app.pipeline.cells import clean_cell, clean_procurement_row, procurement_cells
from backend.app.pipeline.rows import collapse_story_copies


class TestCleanCell:
    @pytest.mark.parametrize("value", [
        None, "", "  ", "None", "none", "null", "NULL", "N/A", "n/a", "NA",
        "nan", "NaN", "TBD", "tbd", "-", "—", " N/A ",
    ])
    def test_placeholders_read_as_blank(self, value):
        assert clean_cell(value) == ""

    def test_real_text_is_stripped_not_changed(self):
        assert clean_cell("  Julius Berger Plc ") == "Julius Berger Plc"
        assert clean_cell("N1.2bn") == "N1.2bn"
        assert clean_cell(0) == "0"


class TestProcurementCells:
    def test_nulls_from_the_extractor_store_as_blanks(self):
        # The schema tells the model to emit null; .get(key, "TBD") never
        # fired for a present-but-null key, so "None" landed in the sheet.
        row = procurement_cells({"agency": "FMW", "contractor": None, "amount": None,
                                 "project": None}, "Road award", "Punch")
        assert row == {"Agency": "FMW", "Contractor": "", "Amount": "",
                       "Project": "Road award", "Source": "Punch"}

    def test_placeholders_store_as_blanks_and_real_values_survive(self):
        row = procurement_cells({"agency": "FMW", "contractor": "TBD", "amount": "N/A",
                                 "project": "Lagos-Ibadan rehab"}, "Road award", "Punch")
        assert row["Contractor"] == "" and row["Amount"] == ""
        assert row["Project"] == "Lagos-Ibadan rehab"

    def test_no_agency_writes_no_row(self):
        assert procurement_cells({"agency": "N/A", "amount": "N5bn"}, "t", "s") is None
        assert procurement_cells(None, "t", "s") is None
        assert procurement_cells("junk", "t", "s") is None


class TestCleanProcurementRow:
    def test_legacy_placeholders_export_as_blanks(self):
        legacy = {"Agency": "FMW", "Contractor": "TBD", "Amount": "None",
                  "Project": "null", "Source": "Punch"}
        out = clean_procurement_row(legacy)
        assert out == {"Agency": "FMW", "Contractor": "", "Amount": "",
                       "Project": "", "Source": "Punch"}
        assert legacy["Contractor"] == "TBD", "input row must not be mutated"


def run_export(tmp_path, monkeypatch, rows):
    """Drive the real export against a local workbook holding `rows`
    ({tab: [row, ...]}) and return the data directory it wrote."""
    d = SheetsDatabase()
    d.use_local = True
    d.local_path = str(tmp_path / "export.xlsx")
    d._cache = {}
    d._init_db()
    for tab, tab_rows in rows.items():
        for row in tab_rows:
            d._append_row(tab, row)
    out_dir = tmp_path / "data"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "archives").mkdir(exist_ok=True)
    monkeypatch.setattr(rp, "db", d)
    monkeypatch.setattr(rp, "DATA_DIR", str(out_dir))
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    # Side feeds (weather, FX, headlines) are network-only: not under test.
    monkeypatch.setattr(rp.side_feeds, "export_side_feeds", lambda *a, **k: None)
    import backend.app.services.trends as trends_mod
    import backend.app.services.weather as weather_mod
    monkeypatch.setattr(weather_mod, "fetch_weather", lambda *a, **k: None)
    monkeypatch.setattr(trends_mod, "fetch_reddit_nigeria", lambda *a, **k: [])
    rp.export_static_json_database()
    return out_dir


AWARD = {"Agency": "Federal Ministry of Works", "Contractor": "Julius Berger Plc",
         "Amount": "N5bn", "Project": "Lagos-Ibadan expressway rehabilitation",
         "Date": "2026-09-01"}


class TestProcurementExport:
    def test_legacy_placeholders_publish_as_blanks(self, tmp_path, monkeypatch):
        out = run_export(tmp_path, monkeypatch, {"Procurement": [
            {"Agency": "NNPC", "Contractor": "TBD", "Amount": "N/A",
             "Project": "None", "Source": "Punch", "Date": "2026-09-01"},
        ]})
        rows = json.loads((out / "procurement.json").read_text())
        assert rows[0]["Contractor"] == ""
        assert rows[0]["Amount"] == ""
        assert rows[0]["Project"] == ""

    def test_placeholder_contractors_add_no_graph_nodes(self, tmp_path, monkeypatch):
        # 139 of 224 published awards carried "TBD"/"None" contractors, and
        # each became a company node with a "Contract Awardee" edge.
        out = run_export(tmp_path, monkeypatch, {"Procurement": [
            {"Agency": "NNPC", "Contractor": "TBD", "Amount": "N/A",
             "Project": "Pipeline repairs", "Source": "Punch", "Date": "2026-09-01"},
            {"Agency": "FMW", "Contractor": "None", "Amount": "N2bn",
             "Project": "Bridge", "Source": "Punch", "Date": "2026-09-02"},
            AWARD,
        ]})
        graph = json.loads((out / "graph.json").read_text())
        labels = {n["label"] for n in graph["nodes"]}
        assert not labels & {"TBD", "None"}
        assert "Julius Berger Plc" in labels
        assert [e["label"] for e in graph["edges"]].count("Contract Awardee") == 1

    def test_rollup_counts_a_duplicated_award_once(self, tmp_path, monkeypatch):
        out = run_export(tmp_path, monkeypatch, {"Procurement": [
            dict(AWARD, Source="Punch"), dict(AWARD, Source="Vanguard"),
        ]})
        assert len(json.loads((out / "procurement.json").read_text())) == 1
        rollup = json.loads((out / "procurement_rollup.json").read_text())
        works = [a for a in rollup["agencies"] if a["name"] == AWARD["Agency"]][0]
        assert works["contracts"] == 1
        assert works["totals"]["NGN"] == 5e9


class TestEmptySiteGuard:
    def test_ci_run_on_the_local_fallback_refuses_to_export(self, tmp_path, monkeypatch):
        # Sheets unreachable in Actions means the run fell back to an empty
        # local workbook; exporting it would publish an empty site.
        out_dir = tmp_path / "data"
        out_dir.mkdir()
        (out_dir / "latest.json").write_text('[{"Title": "kept"}]')

        class LocalDb:
            use_local = True

        monkeypatch.setattr(rp, "db", LocalDb())
        monkeypatch.setattr(rp, "DATA_DIR", str(out_dir))
        monkeypatch.setenv("GITHUB_ACTIONS", "true")
        with pytest.raises(RuntimeError, match="local"):
            rp.export_static_json_database()
        assert json.loads((out_dir / "latest.json").read_text()) == [{"Title": "kept"}]


def article(i, **extra):
    row = {"Title": f"Dangote Cement raises cement prices in Lagos {i}",
           "Summary": "Dangote Cement raised ex-factory prices.",
           "URL": f"https://punchng.com/story-{i}", "Source": "Punch",
           "Time": "2026-09-01T07:00:00", "Risk Score": 40, "Status": "Unread",
           "Category": "Company"}
    row.update(extra)
    return row


# Eight different stories (one outlet's copies of a story would collapse).
DISTINCT = [
    "Dangote Cement raises ex-factory prices",
    "CBN holds monetary policy rate at 27.5%",
    "NNPC appoints new chief financial officer",
    "SEC suspends trading in Chams shares",
    "Access Holdings completes acquisition of Kenyan bank",
    "FIRS extends VAT filing deadline",
    "MTN Nigeria lists commercial paper on FMDQ",
    "BPP approves N40bn Abuja road contracts",
]


def seed_file(tmp_path, name, n):
    out_dir = tmp_path / "data"
    out_dir.mkdir(exist_ok=True)
    (out_dir / name).write_text(json.dumps([{"Title": f"old {i}"} for i in range(n)]))


class TestShrinkGuard:
    @pytest.fixture(autouse=True)
    def no_image_lookups(self, monkeypatch):
        monkeypatch.setattr(rp.article_images, "attach_images", lambda *a, **k: 0)

    def test_a_collapsed_feed_keeps_the_previous_file(self, tmp_path, monkeypatch, caplog):
        seed_file(tmp_path, "latest.json", 30)
        seed_file(tmp_path, "companies.json", 25)
        out = run_export(tmp_path, monkeypatch, {"Articles": [article(1)]})
        assert len(json.loads((out / "latest.json").read_text())) == 30
        assert len(json.loads((out / "companies.json").read_text())) == 25
        assert "latest.json" in caplog.text

    def test_a_kept_register_reports_no_removals_in_changes_json(self, tmp_path, monkeypatch):
        # The failed read the guard exists for must not tell the site's
        # "what changed this cycle" panel that the whole register went.
        out_dir = tmp_path / "data"
        out_dir.mkdir()
        register = [{"Person Name": f"Holder {i}", "Company": f"Firm {i} Ltd",
                     "Percentage": "10%", "Date": "2026-09-01",
                     "Source": f"https://punchng.com/psc-{i}"}
                    for i in range(30)]
        (out_dir / "significant_control.json").write_text(json.dumps(register))
        out = run_export(tmp_path, monkeypatch, {})
        assert json.loads((out / "significant_control.json").read_text()) == register
        changes = json.loads((out / "changes.json").read_text())
        assert changes["psc_removed"] == []
        holdings = json.loads((out / "psc_timeline.json").read_text())["holdings"]
        assert len(holdings) == 30

    def test_a_small_previous_file_is_replaced(self, tmp_path, monkeypatch):
        seed_file(tmp_path, "latest.json", 10)
        out = run_export(tmp_path, monkeypatch, {"Articles": [article(1)]})
        assert len(json.loads((out / "latest.json").read_text())) == 1

    def test_copies_of_one_story_collapse_in_latest_json(self, tmp_path, monkeypatch):
        headline = "EFCC arraigns former governor over N80bn fraud"
        out = run_export(tmp_path, monkeypatch, {"Articles": [
            article(1, Title=f"{headline} - Punch", Source="Punch", URL="https://punchng.com/a",
                    **{"Risk Score": 40}),
            article(2, Title=f"{headline} - Vanguard", Source="Vanguard",
                    URL="https://vanguardngr.com/b", **{"Risk Score": 70}),
            article(3, Title=f"{headline} - Premium Times", Source="Premium Times",
                    URL="https://premiumtimesng.com/c", **{"Risk Score": 50}),
            article(4),
        ]})
        rows = json.loads((out / "latest.json").read_text())
        assert len(rows) == 2
        kept = [r for r in rows if "EFCC" in r["Title"]][0]
        assert kept["URL"] == "https://vanguardngr.com/b"
        assert sorted(a["url"] for a in kept["Also Reported"]) == [
            "https://premiumtimesng.com/c", "https://punchng.com/a"]
        other = [r for r in rows if "Dangote" in r["Title"]][0]
        assert "Also Reported" not in other

    def test_a_modest_shrink_is_written(self, tmp_path, monkeypatch):
        seed_file(tmp_path, "latest.json", 20)
        out = run_export(tmp_path, monkeypatch,
                         {"Articles": [article(i, Title=t) for i, t in enumerate(DISTINCT)]})
        assert len(json.loads((out / "latest.json").read_text())) == 8


class TestCollapseStoryCopies:
    HEADLINE = "EFCC arraigns former governor over N80bn fraud"

    def copies(self):
        return [
            article(1, Title=f"{self.HEADLINE} - Punch", Source="Punch",
                    URL="https://punchng.com/a", **{"Risk Score": 40}),
            article(2, Title=f"{self.HEADLINE} - Vanguard", Source="Vanguard",
                    URL="https://vanguardngr.com/b", **{"Risk Score": 70}),
            article(3, Title=f"{self.HEADLINE} - Premium Times", Source="Premium Times",
                    URL="https://premiumtimesng.com/c", **{"Risk Score": 50}),
        ]

    def test_three_outlets_become_one_row_keeping_the_highest_risk(self):
        out = collapse_story_copies(self.copies())
        assert len(out) == 1
        assert out[0]["URL"] == "https://vanguardngr.com/b"
        assert out[0]["Also Reported"] == [
            {"outlet": "Punch", "url": "https://punchng.com/a"},
            {"outlet": "Premium Times", "url": "https://premiumtimesng.com/c"},
        ]

    def test_ties_keep_the_first_row_and_inputs_are_not_mutated(self):
        rows = self.copies()
        for r in rows:
            r["Risk Score"] = 50
        out = collapse_story_copies(rows)
        assert out[0]["URL"] == "https://punchng.com/a"
        assert all("Also Reported" not in r for r in rows)

    def test_each_other_outlet_is_listed_once_and_never_the_kept_one(self):
        # "Punch Newspapers" and "Punch" are one outlet: its Google News
        # copy of a Punch story is not "also reported by Punch".
        rows = self.copies() + [
            article(4, Title=f"{self.HEADLINE} - Vanguard", Source="Vanguard News",
                    URL="https://news.google.com/rss/articles/v2", **{"Risk Score": 30}),
            article(5, Title=f"{self.HEADLINE} - Punch", Source="Punch Newspapers",
                    URL="https://news.google.com/rss/articles/p2", **{"Risk Score": 30}),
        ]
        out = collapse_story_copies(rows)
        assert len(out) == 1
        assert out[0]["Also Reported"] == [
            {"outlet": "Punch", "url": "https://punchng.com/a"},
            {"outlet": "Premium Times", "url": "https://premiumtimesng.com/c"},
        ]

    def test_one_outlets_two_copies_list_no_one_else(self):
        rows = [self.copies()[0],
                article(5, Title=f"{self.HEADLINE} - Punch", Source="Punch Newspapers",
                        URL="https://news.google.com/rss/articles/p2", **{"Risk Score": 30})]
        out = collapse_story_copies(rows)
        assert len(out) == 1
        assert "Also Reported" not in out[0]

    def test_different_stories_and_unreadable_rows_are_left_alone(self):
        rows = [article(1), article(2, Title="CBN raises MPR to 27.5%", URL="https://x.ng/m"),
                {"Title": "no url"}]
        assert collapse_story_copies(rows) == rows


class TestRejectPacing:
    def test_a_model_reject_waits_only_for_its_one_sheets_write(self, tmp_path, monkeypatch):
        # The 3.5s wait cited Gemini's 15 RPM, but Gemini does not extract
        # (LLMService.analyze_article: DSPy, Claude, Ollama, NVIDIA). A
        # reject writes one Filtered row, paced like the pre-LLM reject.
        from backend.app.services.ingestion import NewsIngestionService
        from backend.app.services.llm import LLMService

        d = SheetsDatabase()
        d.use_local = True
        d.local_path = str(tmp_path / "run.xlsx")
        d._cache = {}
        d._init_db()
        monkeypatch.setattr(rp, "db", d)
        monkeypatch.setattr(rp, "DATA_DIR", str(tmp_path))
        monkeypatch.setattr(NewsIngestionService, "collect_all", classmethod(lambda cls: [
            {"title": "CBN raises monetary policy rate to 28%", "source": "Punch",
             "url": "https://punchng.com/mpr", "raw_text": "The CBN raised the MPR."}]))
        monkeypatch.setattr(LLMService, "analyze_article",
                            classmethod(lambda cls, t, x: {"relevant": False, "engine": "claude"}))
        monkeypatch.setattr(rp, "export_static_json_database", lambda: None)
        waits = []
        monkeypatch.setattr("time.sleep", lambda s: waits.append(s))
        rp.run_pipeline()
        assert waits == [1.0]
