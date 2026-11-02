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


# --- grounding: nothing reaches a reader that the article does not state ---

_NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")
_CAPWORD = re.compile(r"\b[A-Z][A-Za-z'’&-]+\b|\b[A-Z]{2,}\b")
_TAGS = re.compile(r"<[^>]+>")
# Words that state wrongdoing. Allowed only when the article uses the word
# and the sentence attributes it to someone.
ACCUSATORY = (
    "fraud", "corrupt", "embezzl", "launder", "loot", "stole", "stolen", "divert",
    "kickback", "bribe", "inflat", "scam", "cover-up", "illegal", "crony", "guilty",
)
ATTRIBUTION = ("alleg", "accord", "said", "says", "report", "charged", "claim", "accus")
SUPERLATIVES = ("largest", "biggest", "record", "first-ever", "unprecedented", "historic")
ADVICE = ("buy ", "sell ", "invest in", "price target", "will surge", "will crash")
# Capitalised words that carry no claim (sentence starts, months, roles).
_COMMON = {
    "the", "a", "an", "this", "that", "it", "its", "if", "in", "on", "for", "of", "and", "to", "as",
    "with", "by", "at", "from", "under", "after", "while", "when", "who", "which", "their", "they",
    "nigeria", "nigerian", "nigerians", "federal", "government", "state", "president", "governor",
    "minister", "next", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "may", "june", "july", "august", "september",
    "october", "november", "december", "naira", "bn", "mn", "ceo", "md", "dg", "plc", "ltd",
}


def numbers_in(text: str) -> set:
    """Figures in a text, normalised so 4,600 and 4600 compare equal."""
    out = set()
    for raw in _NUMBER.findall(text or ""):
        n = raw.replace(",", "")
        if "." in n:
            n = n.rstrip("0").rstrip(".")
        out.add(n)
    return out


def names_in(text: str) -> set:
    """Capitalised words that name someone or something (lowercased)."""
    out = set()
    for w in _CAPWORD.findall(text or ""):
        base = re.sub(r"['’]s$", "", w).strip("-'’").lower()
        if base and base not in _COMMON and len(base) > 1:
            out.add(base)
    return out


def _words(text: str) -> set:
    return {w.lower() for w in re.findall(r"[A-Za-z0-9]+", text or "")}


def grounded(line: str, source: str) -> bool:
    """Every figure and every name in `line` appears in `source`."""
    if not source:
        return True
    src_numbers = numbers_in(source)
    src_words = _words(source)
    if not numbers_in(line) <= src_numbers:
        return False
    for name in names_in(line):
        parts = re.findall(r"[a-z0-9]+", name)
        if parts and not all(p in src_words for p in parts):
            return False
    return True


def careful(line: str, source: str) -> bool:
    """No unattributed accusation, superlative or investment language."""
    low = (line or "").lower()
    src = (source or "").lower()
    for word in ACCUSATORY:
        if word in low and not (word in src and any(a in low for a in ATTRIBUTION)):
            return False
    if any(w in low and w not in src for w in SUPERLATIVES):
        return False
    return not any(w in low for w in ADVICE)


def detail_level(text: str, title: str = "", source: str = "") -> str:
    """How much of the article the extractor saw: full, snippet or headline."""
    body = _TAGS.sub(" ", text or "")
    for part in (title, source):
        if part:
            body = body.replace(part, " ")
    size = len(_SPACES.sub(" ", body).strip())
    if size >= 1500:
        return "full"
    if size >= 200:
        return "snippet"
    return "headline"


def article_cells(analysis: Dict[str, Any], source_text: str = "", title: str = "", source: str = "") -> Dict[str, str]:
    """The Articles columns for one analysed article.

    With the article text in hand, a fact or why-it-matters line naming a
    figure or a person the text does not contain is dropped, and so is an
    unattributed accusation: an empty field is better than an invented one.
    """
    analysis = analysis or {}
    basis = " ".join(x for x in (title, source_text) if x)
    facts = [
        f for f in clean_facts(analysis.get("key_facts"), analysis.get("summary") or "")
        if grounded(f, basis) and careful(f, basis)
    ]
    why = clean_why(analysis.get("why_it_matters"))
    if why and not (grounded(why, basis) and careful(why, basis)):
        why = ""
    cells = {
        "Key Facts": FACT_SEPARATOR.join(facts),
        "Why It Matters": why,
    }
    if source_text or title:
        cells["Detail"] = detail_level(source_text, title, source)
    return cells


def from_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """Key facts, why-it-matters and detail level read back from an Articles row."""
    row = row or {}
    detail = str(row.get("Detail") or "").strip().lower()
    return {
        "key_facts": clean_facts(row.get("Key Facts"), row.get("Summary") or ""),
        "why_it_matters": clean_why(row.get("Why It Matters")),
        "detail": detail if detail in ("full", "snippet", "headline") else "",
    }
