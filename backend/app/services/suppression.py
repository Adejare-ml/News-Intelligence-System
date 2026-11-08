"""Names the owner has unpublished (static/data/suppressed.json).

A person or company that disputes a record, or must come off the site for
any other reason, is added with scripts/unpublish.py. The export then drops
every row that names them, so no published file, the graph, or the email
digest carries the name. The sheet keeps its rows: this is a publishing
decision, not a deletion.

One matching rule, shared with the site's build (web/src/lib/suppressed.ts),
applied to every text value in a row, not just the name columns, because
free text (Key Facts, Previous Holder, Source Title, Event) is published
too. A value names a hidden entity when:

* the hidden name appears in it as whole words, ignoring case, accents,
  punctuation, single-letter initials and honorifics, so "Aliko Dangote"
  also hides "Alhaji Aliko Dangote" and "Tony Elumelu" hides "Tony O.
  Elumelu", but "Aliko Dangote" does not hide "Dangote Cement"; or
* the whole value has the same canonical key as the hidden name
  (register_quality.canonical_person / canonical_company, the keys the
  register groups by), so "Dangote Cement Plc" hides "Dangote Cement".

A company key that shrinks to one word ("Access Holdings" -> "access") is
only used for whole values, or it would hide every story saying "access".
"""
from __future__ import annotations

import json
import os
import re
from typing import Any, Callable, Dict, Iterable, Iterator, List

from backend.app.services.register_quality import _fold, canonical_company, canonical_person

FILE_NAME = "suppressed.json"

# Names shorter than this would match inside unrelated words and initials.
_MIN_LEN = 3


def _no_initials(text: str) -> str:
    return " ".join(w for w in text.split() if len(w) > 1)


class _Matcher:
    """The hidden names, prepared once for matching many values."""

    def __init__(self, hidden: Iterable[str]):
        needles, keys = set(), set()
        for name in hidden:
            needles |= {_no_initials(_fold(name)), _no_initials(canonical_person(name))}
            company = canonical_company(name)
            if len(company.split()) > 1:
                needles.add(company)
            keys |= {canonical_person(name), company}
        needles = sorted((n for n in needles if len(n) >= _MIN_LEN), key=len, reverse=True)
        self.keys = {k for k in keys if len(k) >= _MIN_LEN}
        self.pattern = (re.compile(r"(^| )(" + "|".join(map(re.escape, needles)) + r")( |$)")
                        if needles else None)

    def __call__(self, text: Any) -> bool:
        value = str(text or "")
        if not value.strip() or self.pattern is None:
            return False
        if self.pattern.search(_no_initials(_fold(value))):
            return True
        # Entities columns hold several names: "Ada Obi|Kola Holdings".
        return any(canonical_person(part) in self.keys or canonical_company(part) in self.keys
                   for part in value.split("|"))


def _strings(value: Any) -> Iterator[str]:
    """Every text value in a row, nested lists and dicts included."""
    if isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from _strings(v)
    elif isinstance(value, str):
        yield value


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


def matcher(hidden: Iterable[str]) -> Callable[[Any], bool]:
    """names() with the hidden list prepared once, for testing many texts."""
    return _Matcher(hidden)


def names(text: Any, hidden: Iterable[str]) -> bool:
    """True when `text` names any hidden entity (the rule above)."""
    return _Matcher(hidden)(text)


def without(rows: List[Dict[str, Any]], hidden: List[str]) -> List[Dict[str, Any]]:
    """`rows` without those where any text value names a hidden entity."""
    if not hidden:
        return rows
    match = _Matcher(hidden)
    return [row for row in rows if not any(match(v) for v in _strings(row))]


def scrub(hidden: List[str], **tables: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Each table without the rows that name a hidden entity.

    Tables are passed by name (articles, psc, ...). With nothing hidden the
    lists come back untouched.
    """
    return {table: without(rows, hidden) for table, rows in tables.items()}

