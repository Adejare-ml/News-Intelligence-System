import pytest
from backend.app.db.excel_db import SHEETS_CONFIG, plan_header_migration


def test_no_change_when_headers_already_match():
    cols = SHEETS_CONFIG["Significant Control"]
    plan = plan_header_migration(cols, cols)
    assert plan["needs_migration"] is False


def test_detects_missing_columns():
    existing = ["Person Name", "Company", "Nature of Control", "Percentage",
                "Change Type", "Previous Holder", "Date"]
    plan = plan_header_migration(existing, SHEETS_CONFIG["Significant Control"])
    assert plan["needs_migration"] is True
    assert "Board Role" in plan["added"]
    assert "PEP Status" in plan["added"]


def test_remaps_rows_by_name_not_position():
    """Board Role inserts at index 3, so positional copying would corrupt rows."""
    existing = ["Person Name", "Company", "Nature of Control", "Percentage",
                "Change Type", "Previous Holder", "Date"]
    target = SHEETS_CONFIG["Significant Control"]
    row = ["Femi Otedola", "Geregu Power Plc", "Direct ownership", "78.6%",
           "Disclosed", "", "2026-04-12"]

    plan = plan_header_migration(existing, target)
    migrated = plan["remap"](row)

    assert len(migrated) == len(target)
    # Values must still sit under their own headers, not shift one column left
    assert migrated[target.index("Percentage")] == "78.6%"
    assert migrated[target.index("Date")] == "2026-04-12"
    assert migrated[target.index("Company")] == "Geregu Power Plc"
    # Newly added columns are blank, never invented
    assert migrated[target.index("Board Role")] == ""
    assert migrated[target.index("PEP Status")] == ""


def test_preserves_unknown_existing_columns_are_dropped_safely():
    """A stale column not in the target must not shift the remaining values."""
    existing = ["Person Name", "Legacy Notes", "Company"]
    target = ["Person Name", "Company", "Date"]
    plan = plan_header_migration(existing, target)
    migrated = plan["remap"](["Aliko Dangote", "old note", "Dangote Cement Plc"])
    assert migrated == ["Aliko Dangote", "Dangote Cement Plc", ""]


def test_short_rows_do_not_raise():
    existing = ["Person Name", "Company", "Date"]
    target = ["Person Name", "Company", "Date"]
    plan = plan_header_migration(existing, target)
    assert plan["remap"](["Only Name"]) == ["Only Name", "", ""]


def test_articles_engine_column_is_detected_as_missing():
    existing = ["ID", "Time", "Title", "Source", "URL", "Category",
                "Risk Score", "Summary", "Status"]
    plan = plan_header_migration(existing, SHEETS_CONFIG["Articles"])
    assert plan["needs_migration"] is True
    assert "Engine" in plan["added"]


class FakeWorksheet:
    """Minimal gspread worksheet stand-in for the migration path."""

    def __init__(self, values, col_count=10):
        self._values = [list(r) for r in values]
        self.col_count = col_count
        self.cleared = False
        self.added_cols = 0

    def get_all_values(self):
        return [list(r) for r in self._values]

    def clear(self):
        self.cleared = True
        self._values = []

    def add_cols(self, n):
        self.added_cols += n
        self.col_count += n

    def update(self, values=None, range_name=None):
        self._values = [list(r) for r in values]


def _db_with_fake(monkeypatch):
    from backend.app.db.excel_db import SheetsDatabase
    db = SheetsDatabase.__new__(SheetsDatabase)   # bypass __init__ / credentials
    db._cache = {}
    return db


def test_migration_rewrites_stale_psc_tab(monkeypatch):
    target = SHEETS_CONFIG["Significant Control"]
    stale = ["Person Name", "Company", "Nature of Control", "Percentage",
             "Change Type", "Previous Holder", "Date"]
    ws = FakeWorksheet([
        stale,
        ["Femi Otedola", "Geregu Power Plc", "Direct ownership", "78.6%",
         "Disclosed", "", "2026-04-12"],
    ])
    db = _db_with_fake(monkeypatch)
    db._migrate_worksheet_headers(ws, "Significant Control", target)

    assert ws.get_all_values()[0] == target
    row = ws.get_all_values()[1]
    assert row[target.index("Percentage")] == "78.6%"
    assert row[target.index("Date")] == "2026-04-12"
    assert row[target.index("Board Role")] == ""


def test_migration_is_noop_when_schema_current(monkeypatch):
    target = SHEETS_CONFIG["Articles"]
    ws = FakeWorksheet([target, ["1", "t", "title", "src", "u", "Company", "10", "s", "Unread", "ollama"]])
    db = _db_with_fake(monkeypatch)
    db._migrate_worksheet_headers(ws, "Articles", target)
    assert ws.cleared is False


def test_empty_tab_gets_header(monkeypatch):
    target = SHEETS_CONFIG["Procurement"]
    ws = FakeWorksheet([])
    db = _db_with_fake(monkeypatch)
    db._migrate_worksheet_headers(ws, "Procurement", target)
    assert ws.get_all_values()[0] == target
