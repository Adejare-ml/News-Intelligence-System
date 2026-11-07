"""Names the owner has unpublished (static/data/suppressed.json).

A person or company that disputes a record, or must come off the site for
any other reason, is added with scripts/unpublish.py. The export then drops
every row that names them, so no published file, the graph, or the email
digest carries the name. The sheet keeps its rows: this is a publishing
decision, not a deletion.

One matching rule, shared with the site's build (web/src/lib/suppressed.ts):
a value names a hidden entity when the hidden name appears in it as whole
words, ignoring case. "Aliko Dangote" therefore also hides "Alhaji Aliko
Dangote", but not "Dangote Cement".
"""
from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, Iterable, List

FILE_NAME = "suppressed.json"

# The name columns of each exported table. A row is dropped when any of
# them names a hidden entity.
_FIELDS = {
    "articles": ("Title", "Summary", "Entities"),
    "companies": ("Company",),
    "people": ("Name", "Organization"),
    "agencies": ("Agency",),
    "procurement": ("Agency", "Contractor"),
    "psc": ("Person Name", "Company"),
}


def _key(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace(" ", " ")).strip().lower()


def load(data_dir: str) -> List[str]:
    """The hidden names. A missing or unreadable file hides nothing."""
    try:
        with open(os.path.join(data_dir, FILE_NAME), encoding="utf-8") as f:
            entries = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(entries, list):
        return []
    return [str(e["name"]).strip() for e in entries
            if isinstance(e, dict) and str(e.get("name") or "").strip()]


def names(text: Any, hidden: Iterable[str]) -> bool:
    """True when `text` mentions any hidden name as whole words."""
    haystack = _key(text)
    if not haystack:
        return False
    for name in hidden:
        n = _key(name)
        # Very short names would match inside unrelated words and initials.
        if len(n) >= 3 and re.search(rf"(^|[^a-z0-9]){re.escape(n)}($|[^a-z0-9])", haystack):
            return True
    return False


def scrub(hidden: List[str], **tables: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Each table without the rows that name a hidden entity.

    Tables are passed by name (articles, companies, people, agencies,
    procurement, psc). With nothing hidden the lists come back untouched.
    """
    if not hidden:
        return dict(tables)
    return {
        table: [row for row in rows
                if not any(names(row.get(field), hidden) for field in _FIELDS[table])]
        for table, rows in tables.items()
    }


def drop_alerts(alerts: List[Dict[str, Any]], hidden: List[str]) -> List[Dict[str, Any]]:
    """Exported alerts (analytics.recent_alerts) that name no hidden entity."""
    return [a for a in alerts
            if not names(f"{a.get('title', '')} {'|'.join(a.get('entities') or [])}", hidden)]
