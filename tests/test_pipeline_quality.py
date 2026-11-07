"""Pipeline data quality: missing cells stored and exported as blanks,
the procurement rollup counted after dedupe, and the export refusing to
publish an empty site over a full one.
"""
import json

import pytest

import run_pipeline as rp
from backend.app.db.excel_db import SheetsDatabase
from backend.app.pipeline.cells import clean_cell, clean_procurement_row, procurement_cells


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

    def test_a_small_previous_file_is_replaced(self, tmp_path, monkeypatch):
        seed_file(tmp_path, "latest.json", 10)
        out = run_export(tmp_path, monkeypatch, {"Articles": [article(1)]})
        assert len(json.loads((out / "latest.json").read_text())) == 1

    def test_a_modest_shrink_is_written(self, tmp_path, monkeypatch):
        seed_file(tmp_path, "latest.json", 20)
        out = run_export(tmp_path, monkeypatch,
                         {"Articles": [article(i) for i in range(8)]})
        assert len(json.loads((out / "latest.json").read_text())) == 8
