import pytest
from backend.app.db.excel_db import SHEETS_CONFIG

# The enriched fields run_pipeline.py writes for every extracted PSC record.
# _append_row filters strictly to SHEETS_CONFIG columns, so anything missing
# here is silently discarded between the LLM and the sheet.
ENRICHED_PSC_FIELDS = [
    "Board Role",
    "Direct %",
    "Indirect %",
    "Intermediate Entities",
    "PEP Status",
    "Risk Level",
    "Regulatory Filing Ref",
    "Verification Status",
]


def test_psc_sheet_carries_enriched_fields():
    columns = SHEETS_CONFIG["Significant Control"]
    missing = [f for f in ENRICHED_PSC_FIELDS if f not in columns]
    assert not missing, f"PSC fields dropped by the DB layer: {missing}"


def test_psc_sheet_keeps_original_fields():
    columns = SHEETS_CONFIG["Significant Control"]
    for field in ["Person Name", "Company", "Nature of Control", "Percentage",
                  "Change Type", "Previous Holder", "Date"]:
        assert field in columns, f"Original PSC column lost: {field}"


def test_pipeline_psc_payload_survives_column_filter():
    """Every key run_pipeline.py writes must map to a configured column."""
    columns = set(SHEETS_CONFIG["Significant Control"])
    written_by_pipeline = {
        "Person Name", "Company", "Nature of Control", "Board Role", "Percentage",
        "Direct %", "Indirect %", "Intermediate Entities", "PEP Status",
        "Risk Level", "Regulatory Filing Ref", "Verification Status",
        "Change Type", "Previous Holder", "Date",
    }
    dropped = written_by_pipeline - columns
    assert not dropped, f"Pipeline writes fields the sheet drops: {sorted(dropped)}"
