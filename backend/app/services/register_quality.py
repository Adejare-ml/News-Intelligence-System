"""Validation gate for the published register, contracts and brief.

Everything here is a pure function run at export. Nothing is deleted from
the database: rows are annotated (canonical keys, what kind of claim they
make, quality flags) so the site can group, label and hold back rows
honestly instead of printing every extraction as fact.

Why each piece exists, from the live export:

* The same person arrives as "Alhaji Aliko Dangote" and "Aliko Dangote",
  "Tony O. Elumelu" and "Tony Elumelu"; the same company as "Dangote
  Refinery" and "Dangote Petroleum Refinery". Without canonical keys the
  site shows them as different holders and holdings.
* A board role ("Chairman", "Founder") with no stake is not a shareholding,
  but it was drawn on the same bar as one.
* Seven rows carry no source at all, yet counted in the headline numbers.
* The extractor occasionally files a sports or entertainment figure as a
  holder (a footballer "controlling" a fashion business). Those are held
  back for review rather than published as ownership intelligence.
* Procurement rows repeat when several outlets report the same award.
* The LLM brief can garble a headline ("Georgia's FCAU receives MMA2
  revenue" for a story about FAAN); the source title is the safer text.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Dict, Iterable, List, Optional

from backend.app.services import relevance
from backend.app.services.trends import strip_publisher

# --- canonical names ---------------------------------------------------------

_HONORIFICS = {
    "alhaji", "alhaja", "hajia", "hajiya", "chief", "dr", "sir", "mr", "mrs",
    "ms", "otunba", "engr", "prof", "professor", "senator", "sen", "hon",
    "barr", "pastor", "oba", "dame", "lady", "arc", "high", "amb",
}

# Trailing words that name the legal form, not the company.
_COMPANY_SUFFIXES = {
    "plc", "ltd", "limited", "nigeria", "nig", "co", "company", "inc",
    "llc", "group", "holdings",
}

# Known variants the reporting uses for one company. Keys and values are
# already-canonical forms.
_COMPANY_ALIASES = {
    "dangote petroleum refinery": "dangote refinery",
    "dangote petroleum refinery and petrochemicals": "dangote refinery",
    "dangote oil refinery": "dangote refinery",
    "firstholdco": "first holdco",
    "fbn holdings": "first holdco",
    "united bank for africa uba": "united bank for africa",
    "uba": "united bank for africa",
    "seplat energy": "seplat",
    "seplat petroleum development": "seplat",
}

_PLACEHOLDERS = {"", "null", "none", "n/a", "na", "unknown", "-", "undefined", "not specified"}


def _fold(text: Any) -> str:
    """Lower-case, strip accents and punctuation, collapse spaces."""
    s = unicodedata.normalize("NFKD", str(text or ""))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"\([^)]*\)", lambda m: " " + m.group(0)[1:-1] + " ", s)
    s = re.sub(r"[^a-z0-9\s]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def canonical_person(name: Any) -> str:
    """'Alhaji Aliko Dangote' and 'Aliko Dangote' -> 'aliko dangote';
    'Tony O. Elumelu' -> 'tony elumelu'."""
    words = _fold(name).split()
    while words and words[0] in _HONORIFICS:
        words.pop(0)
    # A single-letter middle initial is dropped; a lone initial name is kept.
    if len(words) > 2:
        words = [w for i, w in enumerate(words) if not (len(w) == 1 and 0 < i < len(words) - 1)]
    return " ".join(words)


def canonical_company(name: Any) -> str:
    """'Dangote Cement Plc' -> 'dangote cement'; known variants to one key."""
    folded = _fold(name)
    if folded in _COMPANY_ALIASES:
        return _COMPANY_ALIASES[folded]
    words = folded.split()
    while len(words) > 1 and words[-1] in _COMPANY_SUFFIXES:
        words.pop()
    key = " ".join(words)
    return _COMPANY_ALIASES.get(key, key)


# --- what a row claims --------------------------------------------------------

_ROLE_RE = re.compile(
    r"\b(chairman|chairperson|chair|founder|co-founder|cofounder|director|"
    r"ceo|chief executive|managing director|md|president|executive)\b", re.I)
_STAKE_RE = re.compile(r"\b(shares?|shareholding|voting|ownership|owns?|equity|stake)\b", re.I)


def _percent(value: Any) -> Optional[float]:
    text = str(value if value is not None else "").replace("%", "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _clean(value: Any) -> str:
    text = str(value if value is not None else "").strip()
    return "" if text.lower() in _PLACEHOLDERS else text


def classify_row(row: Dict[str, Any]) -> str:
    """'stake' (an ownership claim), 'role' (a board post with no stake) or
    'influence' (control reported without a stake or a post)."""
    if _percent(row.get("Percentage")) is not None:
        return "stake"
    nature = _clean(row.get("Nature of Control"))
    role = _clean(row.get("Board Role"))
    if _STAKE_RE.search(nature):
        return "stake"
    if role and _ROLE_RE.search(role):
        return "role"
    if _ROLE_RE.search(nature):
        return "role"
    return "influence"


# Public figures from sport and entertainment the extractor has filed as
# business holders. Matched on the canonical name. Extend when the review
# queue shows a new one; never add a business figure here.
_NON_BUSINESS_FIGURES = {
    "sadio mane", "victor osimhen", "ademola lookman", "kylian mbappe",
    "lionel messi", "cristiano ronaldo", "wizkid", "burna boy", "davido",
    "tems", "rema", "asake",
}


def quality_flags(row: Dict[str, Any]) -> List[str]:
    """'unsourced', 'implausible' and/or 'no_filing' for one register row."""
    flags = []
    if not _clean(row.get("Source")):
        flags.append("unsourced")
    pct = _percent(row.get("Percentage"))
    person = canonical_person(row.get("Person Name"))
    off_topic = any(
        relevance.is_off_topic(row.get(k)) for k in ("Person Name", "Company", "Nature of Control")
    )
    if (pct is not None and not 0 <= pct <= 100) or person in _NON_BUSINESS_FIGURES or off_topic:
        flags.append("implausible")
    if not _clean(row.get("Regulatory Filing Ref")):
        flags.append("no_filing")
    return flags


def annotate(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Copy each register row with Person Key, Company Key, Kind, Quality
    and Quarantined added. No row is dropped; 'null' board roles are blanked."""
    out = []
    for row in rows or []:
        r = dict(row or {})
        if str(r.get("Board Role", "")).strip().lower() in _PLACEHOLDERS:
            r["Board Role"] = ""
        flags = quality_flags(r)
        r["Person Key"] = canonical_person(r.get("Person Name"))
        r["Company Key"] = canonical_company(r.get("Company"))
        r["Kind"] = classify_row(r)
        r["Quality"] = flags
        r["Quarantined"] = "implausible" in flags
        out.append(r)
    return out


def is_public(row: Dict[str, Any]) -> bool:
    """A row the site may publish: sourced and not quarantined.

    A label is not enough for the rest: "No source on file" next to a named
    person and a stake still publishes the claim. Withheld rows stay in the
    database for review; they never reach the static export.
    """
    quality = row.get("Quality") or quality_flags(row)
    quarantined = row.get("Quarantined")
    if quarantined is None:
        quarantined = "implausible" in quality
    return not quarantined and "unsourced" not in quality


def public_rows(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The annotated rows the site may publish, each marked Public."""
    return [dict(r, Public=True) for r in rows or [] if is_public(r)]


def withheld_summary(rows: Iterable[Dict[str, Any]]) -> Dict[str, int]:
    """Counts only, never names: how many rows the gate kept off the site."""
    rows = list(rows or [])
    quarantined = sum(1 for r in rows if not is_public(r) and r.get("Quarantined"))
    unsourced = sum(1 for r in rows if not is_public(r) and not r.get("Quarantined"))
    return {"checked": len(rows), "published": len(rows) - quarantined - unsourced,
            "unsourced": unsourced, "implausible": quarantined}


def gate(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Annotate and collapse repeats: every row, published or not."""
    return collapse_same_report(annotate(rows))


def collapse_same_report(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drop a row that repeats an earlier report of the same holding on the
    same date with the same stake and nature (spelling variants included)."""
    seen = set()
    out = []
    for r in rows:
        key = (
            r.get("Person Key") or canonical_person(r.get("Person Name")),
            r.get("Company Key") or canonical_company(r.get("Company")),
            str(r.get("Date", ""))[:10],
            _percent(r.get("Percentage")),
            _fold(r.get("Nature of Control")),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


# --- procurement ----------------------------------------------------------------

def _filled(row: Dict[str, Any]) -> int:
    return sum(1 for v in row.values() if _clean(v))


_UNNAMED_RE = re.compile(
    r"\b(unknown|unspecified|unnamed|not specified|not disclosed|undisclosed|tracked contractor|tbd)\b", re.I)
_PROJECT_STOP = {
    "the", "a", "an", "of", "for", "to", "and", "in", "on", "with", "by", "new",
    "deal", "contract", "project", "projects", "funding", "programme", "program",
}


def _contractor(row: Dict[str, Any]) -> str:
    text = _clean(row.get("Contractor"))
    return "" if not text or _UNNAMED_RE.search(text) else canonical_company(text)


def _project_tokens(row: Dict[str, Any]) -> set:
    return {w for w in _fold(row.get("Project")).split() if w not in _PROJECT_STOP and len(w) > 2}


def _same_award(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    """Two outlets' rows for one award: the same disclosed value, and either
    the same project in other words or the same agency, with no two
    different named contractors."""
    if a.get("Amount Value") in (None, "") or a.get("Amount Value") != b.get("Amount Value"):
        return False
    if (a.get("Amount Currency") or "") != (b.get("Amount Currency") or ""):
        return False
    ca, cb = _contractor(a), _contractor(b)
    if ca and cb and ca != cb:
        return False
    ta, tb = _project_tokens(a), _project_tokens(b)
    overlap = len(ta & tb) / len(ta | tb) if ta and tb else 0.0
    same_agency = canonical_company(_clean(a.get("Agency"))) == canonical_company(_clean(b.get("Agency")))
    return overlap >= 0.34 or same_agency


def dedupe_procurement(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One row per award, keeping the fullest report of it.

    Several outlets reporting one award wrote several rows, often with the
    agency or contractor spelled differently ("Bureau of Public Procurement"
    / "Federal Government of Nigeria" for the same N1.5trn reforms). Rows
    with no disclosed value merge only on the same agency, named contractor
    and date. Rows identifying nothing (no value, no named contractor) are
    left as they are.
    """
    rows = list(rows or [])
    kept: List[int] = []
    for i, row in enumerate(rows):
        match = None
        for k, j in enumerate(kept):
            other = rows[j]
            if row.get("Amount Value") not in (None, ""):
                if _same_award(row, other):
                    match = k
                    break
            elif other.get("Amount Value") in (None, "") and _contractor(row):
                if (_contractor(row) == _contractor(other)
                        and canonical_company(_clean(row.get("Agency"))) == canonical_company(_clean(other.get("Agency")))
                        and str(row.get("Date", ""))[:10] == str(other.get("Date", ""))[:10]):
                    match = k
                    break
        if match is None:
            kept.append(i)
        elif _filled(row) > _filled(rows[kept[match]]):
            kept[match] = i
    return [rows[i] for i in kept]


# --- brief headline QA -------------------------------------------------------------

_BULLET_RE = re.compile(
    r"^(?P<lead>\s*[-*]\s+)\*\*(?P<head>[^*]+)\*\*(?P<rest>.*?\]\((?P<url>https?://[^)\s]+)\)+.*)$")
_NAMED_RE = re.compile(r"\b(?:[A-Z]{2,}[A-Z0-9]*|[A-Z][a-z]+(?:['’][a-z]+)?)\b")
# Capitalised words that carry no claim about who or where.
_COMMON_CAPS = {
    "the", "a", "an", "new", "government", "federal", "state", "nigeria",
    "nigerian", "nigerians", "fg", "bn", "trn", "us", "uk", "after", "as",
    "in", "on", "for", "to", "of", "and", "with", "over", "amid", "by",
}


def _named_tokens(text: str) -> set:
    tokens = set()
    for t in _NAMED_RE.findall(text or ""):
        base = re.sub(r"['’]s$", "", t).lower()
        if base not in _COMMON_CAPS:
            tokens.add(base)
    return tokens


def qa_brief_headlines(md: str, records: Iterable[Dict[str, Any]]) -> str:
    """Check every linked bullet's bold headline against its source article.

    A headline naming someone or something the article never mentions is
    replaced by the article's own title and the bullet's commentary by its
    summary. A bullet repeating an article already listed in the same
    section is dropped. Bullets with no matching article are left alone.
    """
    by_url = {}
    for r in records or []:
        url = str(r.get("url") or r.get("URL") or "").strip()
        if url:
            by_url[url] = r
    out = []
    seen_in_section = set()
    for line in (md or "").split("\n"):
        if line.startswith("#"):
            seen_in_section = set()
            out.append(line)
            continue
        m = _BULLET_RE.match(line)
        if not m:
            out.append(line)
            continue
        url = m.group("url")
        # "**Procurement**: ..." is a label, not a headline: nothing to check.
        if m.group("rest").lstrip().startswith(":"):
            out.append(line)
            continue
        if url in seen_in_section:
            continue
        seen_in_section.add(url)
        rec = by_url.get(url)
        if not rec:
            out.append(line)
            continue
        title_raw = str(rec.get("title") or rec.get("Title") or "")
        source = str(rec.get("source") or rec.get("Source") or "")
        title = strip_publisher(title_raw, source).strip()
        summary = str((rec.get("analysis") or {}).get("summary") or rec.get("Summary") or "")
        known = _named_tokens(title) | _named_tokens(summary) | {
            w.lower() for w in re.findall(r"[A-Za-z]+", title + " " + summary)}
        invented = _named_tokens(m.group("head")) - known
        if not title or not invented:
            out.append(line)
            continue
        link = re.search(r"\(\[[^\]]*\]\(https?://[^)\s]+\)\)+", m.group("rest"))
        first = re.split(r"(?<=[.!?])\s", summary.strip(), maxsplit=1)[0] if summary else ""
        tail = (". " + first) if first else ""
        out.append(f"{m.group('lead')}**{title}**{tail} {link.group(0) if link else ''}".rstrip() + "  ")
    return "\n".join(out)
