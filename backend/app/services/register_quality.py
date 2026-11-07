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
from backend.app.services.ingestion import parse_feed_date
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


def holder_key(row: Dict[str, Any]) -> str:
    """Who a register row is about: the canonical name AND company.

    A name alone is not an identity: two different men called Abubakar
    Musa at two companies must not share a record, a timeline or a page,
    and attributing one's holding to the other is exactly the error this
    register cannot afford. Spelling, honorific and suffix variants of one
    person at one company still share the key.
    """
    return f"{canonical_person(row.get('Person Name'))}|{canonical_company(row.get('Company'))}"


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


def has_source_link(row: Dict[str, Any]) -> bool:
    """True when the row links to the article it came from.

    The "Source" column only says how a row was made ("extracted", "seed"),
    so it is no evidence of reporting. Every published claim must link to
    the article behind it.
    """
    return str(row.get("Source URL") or "").strip().startswith(("http://", "https://"))


# --- how strong a claim is -----------------------------------------------------

# The extraction prompt shows this reference as an example; a model that
# found none sometimes copies it, so it is never taken as a real filing.
_EXAMPLE_FILING_REFS = {"cac/psc/2026/0891"}
# A registry reference is a registry prefix and a number ("RC 1234567",
# "BN 3344556") or one unbroken code of letters and digits
# ("CAC/PSC/2026/1187"). Words with a year in them ("SEC disclosure 2026",
# "Not filed as of 2026") are what the model writes when it found none.
_FILING_REF_RE = re.compile(
    r"(?:rc|bn|it|cac|psc)\s*[-/:#.]?\s*\d{3,}|(?=\S*[a-z])(?=\S*\d{3,})\S+", re.I)
_NOT_A_REF_WORDS = {
    "not", "no", "none", "nil", "pending", "unknown", "awaiting", "tbd", "filed",
    "unavailable", "undisclosed", "disclosure", "disclosures", "announcement",
}


def has_filing_ref(row: Dict[str, Any]) -> bool:
    """True when the row carries something shaped like a registry reference."""
    ref = _clean(row.get("Regulatory Filing Ref"))
    if not ref or ref.lower() in _EXAMPLE_FILING_REFS:
        return False
    if any(w in _NOT_A_REF_WORDS for w in _fold(ref).split()):
        return False
    return bool(_FILING_REF_RE.fullmatch(ref))


# What the extractor read when it wrote the row ("Basis" column): only the
# headline and feed snippet, the full article, or (set by the owner after
# checking) a regulatory filing. Rows written before the column existed
# have no basis on record, so they count as the weakest.
_BASES = ("headline", "article", "filing")


def basis_for_detail(detail: Any) -> str:
    """The Basis to store for an extraction, from story_detail.detail_level.

    A feed snippet is still not the article, so only full text counts.
    """
    return "article" if str(detail or "").strip().lower() == "full" else "headline"


def basis_of(row: Dict[str, Any]) -> str:
    basis = _clean(row.get("Basis")).lower()
    return basis if basis in _BASES else "headline"


def is_approved(row: Dict[str, Any]) -> bool:
    """The owner checked the claim and set Approved = yes in the sheet."""
    return _clean(row.get("Approved")).lower() == "yes"


def confidence(row: Dict[str, Any]) -> str:
    """The tier readers see on every published record.

    "Official filing" tells readers a reference is on record, so it needs
    one; an owner who set Basis = filing without entering it gets the tier
    the reporting itself supports.
    """
    if has_filing_ref(row):
        return "Official filing"
    if basis_of(row) == "article":
        return "Full article"
    return "Headline only"


# Words that make a holder a company, trust or vehicle rather than a person.
_HOLDER_ENTITY_WORDS = _COMPANY_SUFFIXES | relevance._ORG_WORDS | {
    "nominees", "nominee", "capital", "investments", "investment", "partners",
    "fund", "ventures", "trustees", "trustee", "llp", "spv",
}

# What the extractor writes in the chain fields when there is no one there.
_NO_HOLDER = {"direct", "direct holding", "direct shareholder"}


def _reads_as_entity(name: str) -> bool:
    """True only on clear evidence that a name is an organisation: it ends
    in an entity word ("Sahel Nominees", "Access Bank Plc") or holds two of
    them ("Vetiva Capital Partners").

    One entity word anywhere is not enough: Trust, Fund and Favour are
    Nigerian first names, and wrongly calling a person a company would
    publish a headline-only claim about them. Unclear names count as people.
    """
    words = _fold(name).split()
    return bool(words) and (
        words[-1] in _HOLDER_ENTITY_WORDS or sum(w in _HOLDER_ENTITY_WORDS for w in words) >= 2)


def _people_named(row: Dict[str, Any]) -> List[str]:
    """The names on a row that read as natural persons: the holder, the
    previous holder and the control chain."""
    names = []
    for field in ("Person Name", "Previous Holder", "Intermediate Entities"):
        name = _clean(row.get(field))
        if name and _fold(name) not in _NO_HOLDER and not _reads_as_entity(name):
            names.append(name)
    return names


def names_person(row: Dict[str, Any]) -> bool:
    """True when the row names a natural person anywhere in the holding.

    Companies-only records (one company holding another) are not claims
    about an individual, so the person rule leaves them alone. A previous
    holder is rendered on the card ("control moved from ..."), so a company
    row that names a person there is a claim about that person too.
    """
    return bool(_people_named(row))


def quality_flags(row: Dict[str, Any]) -> List[str]:
    """'unsourced', 'implausible', 'unverified_person' and/or 'no_filing'
    for one register row."""
    flags = []
    if not has_source_link(row):
        flags.append("unsourced")
    pct = _percent(row.get("Percentage"))
    person = canonical_person(row.get("Person Name"))
    off_topic = any(
        relevance.is_off_topic(row.get(k)) for k in ("Person Name", "Company", "Nature of Control")
    )
    if (pct is not None and not 0 <= pct <= 100) or person in _NON_BUSINESS_FIGURES or off_topic:
        flags.append("implausible")
    # A claim about a named person needs more than a headline behind it:
    # a filing reference, the full article, or the owner's sign-off (an
    # Approved = yes, or a Basis = filing the owner set after checking).
    signed_off = is_approved(row) or basis_of(row) == "filing"
    if names_person(row) and confidence(row) == "Headline only" and not signed_off:
        flags.append("unverified_person")
    if not has_filing_ref(row):
        flags.append("no_filing")
    return flags


# Why a row was kept off the site, in words the owner can act on.
REASONS = {
    "unsourced": "No link to the article that reported it.",
    "implausible": "Judged implausible: a stake out of range, an off-topic story, "
                   "or a sport or entertainment figure.",
    "unverified_person": "Names a person on headline-only reporting: needs a filing "
                         "reference, the full article, or Approved = yes in the sheet.",
}


def annotate(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Copy each register row with Person Key, Company Key, Kind, Quality,
    Quarantined and Confidence added. No row is dropped; 'null' board roles
    are blanked. Person Key and Company Key together are the holder's
    identity (holder_key); the site groups by the pair, never the name."""
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
        r["Confidence"] = confidence(r)
        out.append(r)
    return out


def is_public(row: Dict[str, Any]) -> bool:
    """A row the site may publish: sourced, not quarantined and, when it
    names a person, resting on more than a headline.

    A label is not enough for the rest: "No source on file" next to a named
    person and a stake still publishes the claim. Withheld rows stay in the
    database for review; they never reach the static export.
    """
    quality = row.get("Quality") or quality_flags(row)
    quarantined = row.get("Quarantined")
    if quarantined is None:
        quarantined = "implausible" in quality
    return not quarantined and "unsourced" not in quality and "unverified_person" not in quality


def public_rows(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The annotated rows the site may publish, each marked Public."""
    return [dict(r, Public=True) for r in rows or [] if is_public(r)]


def _pair(row: Dict[str, Any]) -> tuple:
    # The (person, company) key report.compute_cycle_changes diffs on.
    return (str(row.get("Person Name", "")).strip().lower(), str(row.get("Company", "")).strip().lower())


def withheld_names(checked: Iterable[Dict[str, Any]]) -> List[str]:
    """The people named on rows the gate withheld (holder, previous holder,
    control chain), so attach_evidence never quotes a sentence about them
    on another holder's card."""
    return sorted({n for r in checked or [] if not is_public(r) for n in _people_named(r)})


def without_withheld(previous: Iterable[Dict[str, Any]], checked: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The previous export minus every pair the gate now withholds.

    changes.json is public and lists removed pairs by name. Diffed against
    the raw previous export, a claim the gate has just held back (or one
    un-approved after a correction request) would be announced there as
    "removed", naming the person the gate kept off the site.
    """
    checked = list(checked or [])
    shown = {_pair(r) for r in checked if is_public(r)}
    held = {_pair(r) for r in checked if not is_public(r)} - shown
    return [r for r in previous or [] if _pair(r) not in held]


def _withheld_reason(row: Dict[str, Any]) -> str:
    """The one count a withheld row falls under, strongest reason first."""
    if row.get("Quarantined"):
        return "implausible"
    if "unsourced" in (row.get("Quality") or quality_flags(row)):
        return "unsourced"
    return "needs_review"


def withheld_summary(rows: Iterable[Dict[str, Any]]) -> Dict[str, int]:
    """Counts only, never names: how many rows the gate kept off the site."""
    rows = list(rows or [])
    counts = {"unsourced": 0, "implausible": 0, "needs_review": 0}
    for r in rows:
        if not is_public(r):
            counts[_withheld_reason(r)] += 1
    return {"checked": len(rows), "published": len(rows) - sum(counts.values()), **counts}


def review_queue(rows: Iterable[Dict[str, Any]], generated: str) -> Dict[str, Any]:
    """Every withheld row in full, with the reasons it was withheld.

    For the owner only: it names people the gate decided not to publish,
    so it is written outside the published data folder.
    """
    rows = list(rows or [])
    held = [dict(r, Reasons=[REASONS[f] for f in r.get("Quality") or [] if f in REASONS])
            for r in rows if not is_public(r)]
    return {"generated": generated, "counts": withheld_summary(rows), "rows": held}


# --- evidence for each published claim -------------------------------------------

QUOTE_LIMIT = 200
# Key Facts are stored " | "-separated. The pipe is tried first so a fact
# ending in "." does not leave "| " at the start of the next one.
_SENTENCE_SPLIT_RE = re.compile(r"\s*\|\s*|(?<=[.!?])\s+")


def _cut(sentence: str, limit: int = QUOTE_LIMIT) -> str:
    """The sentence, or its opening words up to the limit, marked as cut."""
    if len(sentence) <= limit:
        return sentence
    return sentence[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:") + "…"


def evidence_quote(texts: Iterable[Any], person: Any, withheld: Iterable[Any] = ()) -> str:
    """One stored sentence that names the holder in full, or "".

    Only the holder's full name will do. A surname ("Dangote") or the
    company alone can match a sentence about someone else, which would put
    another person's act on this holder's card. A sentence that names a
    person the gate withheld is never quoted, so their claim cannot reach
    the site on a neighbour's card. The words are lifted as stored; nothing
    is paraphrased, so an empty string is the honest answer.
    """
    holder = _clean(person)
    name = canonical_company(holder) if _reads_as_entity(holder) else canonical_person(holder)
    if not name:
        return ""
    hidden = [canonical_person(w) for w in withheld or () if _clean(w)]
    for t in texts or []:
        for s in _SENTENCE_SPLIT_RE.split(str(t or "")):
            s = s.strip()
            if s and _mentions(s, name) and not any(_mentions(s, h) for h in hidden):
                return _cut(s)
    return ""


def attach_evidence(rows: Iterable[Dict[str, Any]], articles: Iterable[Dict[str, Any]],
                    verified_at: str, withheld: Iterable[Any] = ()) -> List[Dict[str, Any]]:
    """Copy each row with Evidence: {source_url, quote, date, last_verified}.

    The quote comes from the stored article behind the row (its key facts,
    which restate the article's own sentences, then its summary) or the
    row's notes, skipping sentences that name anyone in `withheld`. The
    date is the article's publication day (feeds store RFC-822 times, so
    it is parsed, not sliced) when it is on file, else the day the row was
    extracted.
    """
    by_url = {str(a.get("URL") or a.get("url") or "").strip(): a for a in articles or []}
    withheld = list(withheld or ())
    out = []
    for row in rows or []:
        r = dict(row or {})
        url = str(r.get("Source URL") or "").strip()
        article = by_url.get(url) if url else None
        texts = [article.get("Key Facts"), article.get("Summary")] if article else []
        published = parse_feed_date((article or {}).get("Time"))
        r["Evidence"] = {
            "source_url": url,
            "quote": evidence_quote(texts + [r.get("Notes")], r.get("Person Name"), withheld),
            "date": published.strftime("%Y-%m-%d") if published else str(r.get("Date") or "")[:10],
            "last_verified": verified_at,
        }
        out.append(r)
    return out


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


# --- source backfill for older register rows -----------------------------------------

def _mentions(text: str, name: str) -> bool:
    folded = f" {_fold(text)} "
    words = [w for w in _fold(name).split() if len(w) > 1]
    return bool(words) and all(f" {w} " in folded for w in words)


def backfill_sources(rows: Iterable[Dict[str, Any]], articles: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Attach the reporting to register rows saved before rows carried it.

    A row gets an article only when exactly one article names both the
    person and the company (title, summary or entities). Ambiguous or
    missing matches stay unlinked, and the gate then withholds the row.
    """
    pool = []
    for a in articles or []:
        url = str(a.get("URL") or a.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        text = " ".join(str(a.get(k) or "") for k in ("Title", "title", "Summary", "summary", "Entities"))
        pool.append((url, text, a))
    out = []
    for row in rows or []:
        r = dict(row or {})
        if not has_source_link(r):
            person = str(r.get("Person Name") or "")
            company = str(r.get("Company") or "")
            # Headlines usually name people by surname ("Otedola raises stake").
            surname = (canonical_person(person).split() or [""])[-1]
            hits = {url: a for url, text, a in pool if _mentions(text, surname) and _mentions(text, company)}
            if len(hits) == 1:
                url, a = next(iter(hits.items()))
                r["Source URL"] = url
                r["Source Title"] = str(a.get("Title") or a.get("title") or "")
                r["Publisher"] = str(a.get("Source") or a.get("source") or "")
        out.append(r)
    return out


# --- deterministic clean-up of the model-written brief ---------------------------------

_HEADING_RE = re.compile(r"^#{2,3}\s+(.+?)\s*$")
_ITEM_RE = re.compile(r"^\s*[-*]\s+")
_URL_RE = re.compile(r"\]\((https?://[^)\s]+)\)")
_SOURCE_TAG_RE = re.compile(r"\{\s*source:([^}]*)\}")
_HIGH = {"high", "critical"}


def _record_text(rec: Dict[str, Any]) -> str:
    analysis = rec.get("analysis") or {}
    return " ".join(str(x or "") for x in (rec.get("title") or rec.get("Title"), analysis.get("summary") or rec.get("Summary")))


def _risk(rec: Optional[Dict[str, Any]]) -> str:
    if not rec:
        return ""
    analysis = rec.get("analysis") or {}
    return str(analysis.get("risk_level") or rec.get("Risk Level") or "").strip().lower()


def _cite(rec: Dict[str, Any]) -> str:
    url = str(rec.get("url") or rec.get("URL") or "")
    source = str(rec.get("source") or rec.get("Source") or "Source").replace("[", "(").replace("]", ")")
    return f"([{source}]({url}))"


def _strip_citations(text: str) -> str:
    """The bullet without its trailing citations (links or {source: ...} tags)."""
    body = text.rstrip()
    while True:
        trimmed = body.rstrip(" .;,")
        if trimmed.endswith(")") or trimmed.endswith("}"):
            # Cut back to the "(" that opens the citation group, when the
            # group holds only citations.
            start = trimmed.rfind(" (")
            if start == -1:
                start = trimmed.rfind("(")
            group = trimmed[start:].strip()
            # Any "[Name](...)" counts, even when the model broke the URL
            # (spaces inside it); a broken link is still only a citation.
            leftover = _SOURCE_TAG_RE.sub("", re.sub(r"\[[^\]]*\]\([^)]*\)", "", group))
            if start != -1 and not leftover.strip("() ;,&and"):
                body = trimmed[:start]
                continue
        return trimmed


def clean_brief(md: str, records: Iterable[Dict[str, Any]]) -> str:
    """Make the model's brief safe to publish and send, by rule:

    - every bullet cites one of the day's articles: a {source: X} tag is
      replaced by that article's link, and a bullet that matches no article
      is dropped;
    - "High Risk Alerts" keeps only articles the analysis rated High or
      Critical (the model sometimes files medium-risk items there);
    - sport and celebrity stories are dropped;
    - each article appears once: a story listed in a specific section is
      not repeated under "Key Developments".
    """
    recs = [r for r in records or [] if str(r.get("url") or r.get("URL") or "").startswith("http")]
    by_url = {str(r.get("url") or r.get("URL")): r for r in recs}

    def find(line: str) -> Optional[Dict[str, Any]]:
        for url in _URL_RE.findall(line):
            if url in by_url:
                return by_url[url]
        words = _named_tokens(line)
        best, score = None, 0
        for r in recs:
            shared = len(words & _named_tokens(_record_text(r)))
            if shared > score:
                best, score = r, shared
        return best if score >= 2 else None

    # Pass 1: sections and their bullets.
    blocks: List[Dict[str, Any]] = []
    current = {"title": "", "lines": []}
    blocks.append(current)
    for line in (md or "").split("\n"):
        h = _HEADING_RE.match(line)
        if h:
            current = {"title": h.group(1), "lines": [line]}
            blocks.append(current)
        else:
            current["lines"].append(line)

    def is_key(title: str) -> bool:
        return "key development" in title.lower()

    def is_alert(title: str) -> bool:
        return "risk" in title.lower() or "alert" in title.lower()

    cleaned: List[Dict[str, Any]] = []
    for block in blocks:
        items = []
        for line in block["lines"]:
            if not _ITEM_RE.match(line):
                items.append((line, None))
                continue
            rec = find(line)
            if rec is None:
                continue  # uncited: nothing to link a reader to
            if relevance.is_off_topic(rec.get("title") or rec.get("Title"), (rec.get("analysis") or {}).get("summary")):
                continue
            if is_alert(block["title"]) and _risk(rec) not in _HIGH:
                continue
            body = _strip_citations(line)
            if not body.endswith((".", "!", "?", "*")):
                body += "."
            items.append((f"{body} {_cite(rec)}  ", str(rec.get("url") or rec.get("URL"))))
        cleaned.append({"title": block["title"], "items": items})

    elsewhere = {url for b in cleaned if not is_key(b["title"]) for _, url in b["items"] if url}
    out: List[str] = []
    for b in cleaned:
        seen = set()
        lines: List[str] = []
        for line, url in b["items"]:
            if url and (url in seen or (is_key(b["title"]) and url in elsewhere)):
                continue
            if url:
                seen.add(url)
            lines.append(line)
        # A section the rules emptied keeps its heading with a plain line,
        # rather than a bare heading readers take for a rendering fault.
        has_content = any(l.strip() and not _HEADING_RE.match(l) for l in lines)
        if b["title"] and not has_content:
            empty = "No high-risk items today." if is_alert(b["title"]) else "Nothing to report here today."
            lines = [lines[0], empty, ""] if lines else [empty]
        out.extend(lines)
    return "\n".join(out)
