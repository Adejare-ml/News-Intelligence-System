"""
The significant-control register must not accumulate the same disclosure twice.

run_pipeline appends a row per extracted disclosure per article, so one
disclosure reported by two articles in the same cycle used to land twice. The
live register carried an exact duplicate pair from 2026-08-05 as a result, and
the cross-entity red flag counted rows, so a holder with four rows across two
companies was reported as controlling four.
"""
import os
import pytest
from backend.app.db.excel_db import SheetsDatabase

TEST_DB_PATH = "tests/test_psc_dedupe.xlsx"


@pytest.fixture
def db():
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)
    d = SheetsDatabase()
    d.use_local = True
    d.local_path = TEST_DB_PATH
    d._init_db()
    yield d
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)


def _row(**over):
    base = {
        "Person Name": "Femi Otedola",
        "Company": "First HoldCo",
        "Nature of Control": "Significant influence or control",
        "Percentage": "",
        "Date": "2026-08-05",
    }
    base.update(over)
    return base


def test_identical_disclosure_is_written_once(db):
    """The exact pair observed in the live register."""
    db.add_significant_control(_row())
    db.add_significant_control(_row())
    assert len(db.get_significant_control()) == 1


def test_dedupe_ignores_case_and_surrounding_space(db):
    db.add_significant_control(_row())
    db.add_significant_control(_row(**{"Person Name": "  femi otedola  ", "Company": "FIRST HOLDCO"}))
    assert len(db.get_significant_control()) == 1


def test_same_holding_on_a_later_date_is_a_fresh_sighting(db):
    """Date is part of the identity on purpose -- this must not be collapsed."""
    db.add_significant_control(_row())
    db.add_significant_control(_row(Date="2026-08-07"))
    assert len(db.get_significant_control()) == 2


def test_a_different_nature_of_control_is_a_different_disclosure(db):
    db.add_significant_control(_row())
    db.add_significant_control(_row(**{"Nature of Control": "Ownership of shares"}))
    assert len(db.get_significant_control()) == 2


def test_a_changed_percentage_is_a_different_disclosure(db):
    db.add_significant_control(_row(Percentage="12.4%"))
    db.add_significant_control(_row(Percentage="18.9%"))
    assert len(db.get_significant_control()) == 2


def test_other_companies_for_the_same_person_are_kept(db):
    """Dedupe must not collapse a genuine cross-entity portfolio."""
    db.add_significant_control(_row())
    db.add_significant_control(_row(Company="Geregu Power Plc"))
    rows = db.get_significant_control()
    assert len(rows) == 2
    assert {r["Company"] for r in rows} == {"First HoldCo", "Geregu Power Plc"}


def test_missing_date_is_stamped_and_still_deduped(db):
    """Two undated writes in one run collapse rather than both landing."""
    db.add_significant_control(_row(Date=None))
    db.add_significant_control(_row(Date=None))
    rows = db.get_significant_control()
    assert len(rows) == 1
    assert rows[0]["Date"]
