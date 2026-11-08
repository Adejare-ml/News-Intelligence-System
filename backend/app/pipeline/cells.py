"""Sheet cell hygiene shared by the writers and the exports."""

from typing import Any, Dict, Optional

# What the extractor, pandas and hand-edited sheets write for "nothing":
# stored verbatim they publish as if they were a contractor or an amount.
_MISSING = {"", "none", "null", "n/a", "na", "nan", "tbd", "-", "—"}

_PROCUREMENT_TEXT = ("Agency", "Contractor", "Amount", "Project")


def clean_cell(value: Any) -> str:
    """A cell as stripped text, with placeholders for "missing" as ""."""
    text = str(value if value is not None else "").strip()
    return "" if text.lower() in _MISSING else text


def procurement_cells(proc: Any, title: str, source: str) -> Optional[Dict[str, str]]:
    """The Procurement sheet row for one extracted award, or None.

    The extraction schema tells the model to emit null for what it cannot
    find, so ``proc.get("contractor", "TBD")`` stored the literal "None",
    and the defaults themselves stored "TBD" / "N/A" as if they were a
    contractor and an amount. Missing is now a blank cell; the article
    title stands in for the project only when the model gave none.
    """
    if not isinstance(proc, dict):
        return None
    agency = clean_cell(proc.get("agency"))
    if not agency:
        return None
    return {
        "Agency": agency,
        "Contractor": clean_cell(proc.get("contractor")),
        "Amount": clean_cell(proc.get("amount")),
        "Project": clean_cell(proc.get("project")) or title,
        "Source": source,
    }


def clean_procurement_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """A copy of a stored procurement row with legacy placeholders
    ("TBD", "N/A", "None") in its text columns blanked for export."""
    out = dict(row)
    for key in _PROCUREMENT_TEXT:
        if key in out:
            out[key] = clean_cell(out[key])
    return out
