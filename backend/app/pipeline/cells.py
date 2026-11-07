"""Sheet cell hygiene shared by the writers and the exports."""

from typing import Any

# What the extractor, pandas and hand-edited sheets write for "nothing":
# stored verbatim they publish as if they were a contractor or an amount.
_MISSING = {"", "none", "null", "n/a", "na", "nan", "tbd", "-", "—"}


def clean_cell(value: Any) -> str:
    """A cell as stripped text, with placeholders for "missing" as ""."""
    text = str(value if value is not None else "").strip()
    return "" if text.lower() in _MISSING else text
