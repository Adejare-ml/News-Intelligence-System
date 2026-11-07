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
