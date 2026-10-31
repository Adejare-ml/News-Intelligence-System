"""
Per-story detail for the Morning Brief: the key facts and why-it-matters
lines the extractor reads from the full article text.

The article body is only in hand while the pipeline analyses it, so these
are captured then, stored on the Articles row ("Key Facts" joined with
" | ", "Why It Matters") and read back for the brief and the email. Model
output is cleaned here, in one place, before it reaches a reader.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

FACT_SEPARATOR = " | "
MAX_FACTS = 4
MAX_FACT_CHARS = 200
MAX_WHY_CHARS = 320

_PLACEHOLDERS = {"", "null", "none", "n/a", "na", "unknown", "-"}
_SPACES = re.compile(r"\s+")


def _clean_text(value: Any, limit: int) -> str:
    text = _SPACES.sub(" ", str(value if value is not None else "")).strip().strip("-•* ").strip()
    if text.lower() in _PLACEHOLDERS:
        return ""
    if len(text) > limit:
        cut = text[:limit].rsplit(" ", 1)[0].rstrip(",;:")
        text = cut + "…"
    return text


def clean_facts(value: Any, summary: str = "") -> List[str]:
    """Up to four distinct, non-empty facts; a fact repeating the summary is dropped."""
    if isinstance(value, str):
        items = value.split(FACT_SEPARATOR) if FACT_SEPARATOR in value else value.split("\n")
    elif isinstance(value, (list, tuple)):
        items = list(value)
    else:
        items = []
    seen = set()
    summary_key = _SPACES.sub(" ", (summary or "").lower()).strip()
    out = []
    for item in items:
        fact = _clean_text(item, MAX_FACT_CHARS).replace(FACT_SEPARATOR.strip(), "/")
        key = fact.lower().rstrip(".")
        if not fact or key in seen or (summary_key and key == summary_key.rstrip(".")):
            continue
        seen.add(key)
        out.append(fact)
        if len(out) == MAX_FACTS:
            break
    return out


def clean_why(value: Any) -> str:
    return _clean_text(value, MAX_WHY_CHARS)


def article_cells(analysis: Dict[str, Any]) -> Dict[str, str]:
    """The two Articles columns for one analysed article."""
    analysis = analysis or {}
    facts = clean_facts(analysis.get("key_facts"), analysis.get("summary") or "")
    return {
        "Key Facts": FACT_SEPARATOR.join(facts),
        "Why It Matters": clean_why(analysis.get("why_it_matters")),
    }


def from_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """Key facts and why-it-matters read back from an Articles row."""
    row = row or {}
    return {
        "key_facts": clean_facts(row.get("Key Facts"), row.get("Summary") or ""),
        "why_it_matters": clean_why(row.get("Why It Matters")),
    }
