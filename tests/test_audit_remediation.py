"""Package 31: the 2026-10-10 audit's backend remediations.

Covers the destructive-migration rewrite (write-then-trim, never
clear-first), the dedupe-read failure guards on the entity writes, the
local-Excel formula escaping, and the report prompt's injection
directive. Everything runs against fakes or a temp xlsx -- no network,
no Google credentials.
"""
import threading
from types import SimpleNamespace

import pytest

from backend.app.db.excel_db import SheetsDatabase
from backend.app.services.llm import build_report_prompt


# ---------------------------------------------------------------------------
# Header migration: the one destructive Sheets operation
# ---------------------------------------------------------------------------

class FakeWorksheet:
    """Records the calls _migrate_worksheet_headers makes."""

    def __init__(self, values, col_count=None, fail_update=False):
        self._values = values
        self.col_count = col_count if col_count is not None else (
            max((len(r) for r in values), default=0))
        self.fail_update = fail_update
        self.calls = []

    def get_all_values(self):
        return self._values

    def add_cols(self, n):
        self.calls.append(("add_cols", n))
        self.col_count += n

    def update(self, values=None, range_name=None):
        self.calls.append(("update", range_name, len(values)))
        if self.fail_update:
            raise RuntimeError("quota 429")

    def batch_clear(self, ranges):
        self.calls.append(("batch_clear", list(ranges)))

    def clear(self):  # pragma: no cover - the whole point is it never runs
        self.calls.append(("clear",))
        raise AssertionError("clear() must never be called: a failed update "
                             "after a successful clear wipes the tab.")


def _fake_db():
    return SimpleNamespace(_cache={})


def migrate(ws, columns, sheet_name="Significant Control"):
    SheetsDatabase._migrate_worksheet_headers(_fake_db(), ws, sheet_name, columns)


class TestMigrationNeverClearsFirst:
    OLD = ["Person Name", "Company", "Date"]
    NEW = ["Person Name", "Company", "Board Role", "Date"]

    def test_writes_in_place_and_trims_leftovers(self):
        ws = FakeWorksheet([self.OLD,
                            ["A", "ACo", "2026-01-01"],
                            ["B", "BCo", "2026-01-02"]])
        migrate(ws, self.NEW)
        kinds = [c[0] for c in ws.calls]
        assert "clear" not in kinds
        assert kinds.count("update") == 1
        # Old and new have the same row count and old is narrower, so
        # nothing is left to trim.
        assert "batch_clear" not in kinds

    def test_trailing_rows_and_columns_are_trimmed_after_the_write(self):
        # Shrinking schema: old is wider (5 cols) and the update only
        # rewrites rows 1..3, so row 4 and column 5 are stale remnants.
        old_header = ["Person Name", "Company", "Legacy A", "Legacy B", "Date"]
        new = ["Person Name", "Company", "Date"]
        ws = FakeWorksheet([old_header,
                            ["A", "ACo", "x", "y", "2026-01-01"],
                            ["B", "BCo", "x", "y", "2026-01-02"],
                            ["C", "CCo", "x", "y", "2026-01-03"]])
        migrate(ws, new)
        update_idx = [c[0] for c in ws.calls].index("update")
        clear_idx = [c[0] for c in ws.calls].index("batch_clear")
        assert update_idx < clear_idx, "trim must come after the data is safe"
        ranges = ws.calls[clear_idx][1]
        assert any(r.startswith("D1:") for r in ranges)  # stale columns

    def test_failed_update_leaves_tab_intact_and_is_swallowed(self):
        ws = FakeWorksheet([self.OLD, ["A", "ACo", "2026-01-01"]],
                           fail_update=True)
        migrate(ws, self.NEW)  # must not raise: migration is best-effort
        kinds = [c[0] for c in ws.calls]
        assert "clear" not in kinds
        assert "batch_clear" not in kinds  # never trim after a failed write


# ---------------------------------------------------------------------------
# Entity writes: a failed dedupe read must not abort the batch
# ---------------------------------------------------------------------------

def _bare_db():
    db = object.__new__(SheetsDatabase)
    db._lock = threading.RLock()
    db._cache = {}
    db.use_local = True
    return db


class TestDedupeReadGuards:
    def test_psc_write_survives_a_raising_read(self, monkeypatch):
        db = _bare_db()
        appended = []
        monkeypatch.setattr(db, "get_significant_control",
                            lambda: (_ for _ in ()).throw(RuntimeError("503")),
                            raising=False)
        monkeypatch.setattr(db, "_append_row",
                            lambda sheet, row: appended.append((sheet, row)),
                            raising=False)
        db.add_significant_control({"Person Name": "A", "Company": "ACo",
                                    "Date": "2026-10-10"})
        assert len(appended) == 1, "a dropped disclosure is worse than a duplicate"

    def test_company_insert_survives_a_raising_read(self, monkeypatch):
        db = _bare_db()
        appended = []
        monkeypatch.setattr(db, "get_companies",
                            lambda: (_ for _ in ()).throw(RuntimeError("503")),
                            raising=False)
        monkeypatch.setattr(db, "_append_row",
                            lambda sheet, row: appended.append((sheet, row)),
                            raising=False)
        db.add_company({"Company": "ACo"})
        assert len(appended) == 1
        assert appended[0][1]["Company"] == "ACo"


# ---------------------------------------------------------------------------
# Local-Excel writes: formula injection
# ---------------------------------------------------------------------------

class TestLocalExcelEscaping:
    def test_formula_triggers_are_prefix_escaped(self, tmp_path):
        openpyxl = pytest.importorskip("openpyxl")
        db = _bare_db()
        db.local_path = str(tmp_path / "db.xlsx")
        # mode='a' needs an existing workbook.
        wb = openpyxl.Workbook()
        wb.save(db.local_path)
        assert db._append_row("Articles", {
            "ID": 1,
            "Title": '=HYPERLINK("http://evil","CBN notice")',
            "Summary": "+PLUS()", "Source": "-MINUS()", "URL": "@AT()",
            "Category": "plain text", "Risk Score": 42,
        })
        ws = openpyxl.load_workbook(db.local_path)["Articles"]
        cells = {c.value: c for row in ws.iter_rows(min_row=2) for c in row
                 if c.value not in (None, "")}
        assert '\'=HYPERLINK("http://evil","CBN notice")' in cells
        for value, cell in cells.items():
            assert cell.data_type != "f", f"live formula written: {value!r}"
        assert "plain text" in cells   # untouched
        assert 42 in cells             # numbers untouched


# ---------------------------------------------------------------------------
# Report prompt: injection directive
# ---------------------------------------------------------------------------

class TestReportPromptGuard:
    def test_data_is_delimited_and_directive_present(self):
        prompt = build_report_prompt('{"articles": []}')
        assert '<data>\n{"articles": []}\n</data>' in prompt
        assert "SECURITY DIRECTIVE" in prompt
        # The directive must come after the data it governs is introduced.
        assert prompt.index("SECURITY DIRECTIVE") > prompt.index("</data>")
