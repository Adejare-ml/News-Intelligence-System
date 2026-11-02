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
from decimal import Decimal, InvalidOperation
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

# A figure with its currency and scale, so ₦4.6bn matches "N4,600 million"
# but never ₦4.6tn or $4.6bn.
_AMOUNT = re.compile(
    r"(?P<cur>US\$|₦|\$|£|€|\bNGN\s?|\bUSD\s?|\bN(?=\d))?\s?"
    r"(?P<num>\d[\d,]*(?:\.\d+)?)"
    r"(?:\s?(?P<scale>trillion|billion|million|thousand|trn|tn|bn|mn|m|b|k)\b)?"
    r"(?:\s?(?P<pct>%|per\s?cent\b|percent\b))?"
    r"(?:\s(?P<cur2>naira|dollars?|pounds?|euros?)\b)?",
    re.I,
)
_CURRENCIES = {
    "us$": "USD", "$": "USD", "usd": "USD", "dollar": "USD", "dollars": "USD",
    "₦": "NGN", "n": "NGN", "ngn": "NGN", "naira": "NGN",
    "£": "GBP", "pound": "GBP", "pounds": "GBP", "€": "EUR", "euro": "EUR", "euros": "EUR",
}
_SCALES = {
    "k": 3, "thousand": 3, "m": 6, "mn": 6, "million": 6,
    "b": 9, "bn": 9, "billion": 9, "tn": 12, "trn": 12, "trillion": 12,
}
# Counts written as words ("five directors"); "one" is left alone, it is
# too often not a count.
_NUMBER_WORDS = {
    "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20, "dozen": 12,
}
_NUMBER_WORD = re.compile(r"\b(" + "|".join(_NUMBER_WORDS) + r")\b", re.I)


def amounts_in(text: str) -> set:
    """Figures as (kind, value): kind is a currency code, '%' or '' (a bare number)."""
    text = _NUMBER_WORD.sub(lambda m: str(_NUMBER_WORDS[m.group(1).lower()]), text or "")
    out = set()
    for m in _AMOUNT.finditer(text):
        try:
            value = Decimal(m.group("num").replace(",", ""))
        except InvalidOperation:
            continue
        scale = (m.group("scale") or "").lower()
        value = value.scaleb(_SCALES.get(scale, 0)).normalize()
        cur = (m.group("cur") or m.group("cur2") or "").strip().lower()
        kind = "%" if m.group("pct") else _CURRENCIES.get(cur, "")
        out.add((kind, value))
    return out


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


def _amount_backed(item, source_amounts: set) -> bool:
    kind, value = item
    if kind == "":
        return any(v == value for _, v in source_amounts)
    return item in source_amounts or ("", value) in source_amounts


def grounded(line: str, source: str) -> bool:
    """Every figure (with its currency and scale) and every name in `line` appears in `source`."""
    if not source:
        return True
    src_amounts = amounts_in(source)
    if not all(_amount_backed(a, src_amounts) for a in amounts_in(line)):
        return False
    src_words = _words(source)
    for name in names_in(line):
        parts = re.findall(r"[a-z0-9]+", name)
        if parts and not all(p in src_words for p in parts):
            return False
    return True


# --- careful: no accusation, legal step or reversal the article does not state ---

def _terms(*pairs):
    return [(key, re.compile(pattern, re.I)) for key, pattern in pairs]


# Words that state wrongdoing. Allowed only when the article uses the word and
# the line attributes it ("alleged", "according to", "said").
ACCUSATORY = _terms(
    ("fraud", r"\b(?:fraud\w*|defraud\w*)\b"),
    ("corrupt", r"\bcorrupt\w*\b"),
    ("embezzle", r"\bembezzl\w*\b"),
    ("launder", r"\blaunder\w*\b"),
    ("loot", r"\bloot\w*\b"),
    ("steal", r"\b(?:stole|stolen|steal\w*|theft|thefts|thieve\w*)\b"),
    ("divert", r"\b(?:divert\w*|diversion)\b"),
    ("misappropriate", r"\bmisappropriat\w*\b"),
    ("siphon", r"\bsiphon\w*\b"),
    ("bribe", r"\b(?:brib\w*|kickbacks?)\b"),
    ("graft", r"\bgraft\b"),
    ("inflate", r"\b(?:inflated|inflating|over-?invoic\w*|padd(?:ed|ing))\b"),
    ("scam", r"\bscam\w*\b"),
    ("cover-up", r"\bcover-?ups?\b"),
    ("crony", r"\bcron(?:y|ies)\b"),
    ("extort", r"\bextort\w*\b"),
    ("ponzi", r"\bponzi\b"),
    ("mismanage", r"\bmismanag\w*\b"),
    ("abuse of office", r"\babuse of (?:office|power)\b"),
    ("forge", r"\bforg(?:ed|ery|eries|ing)\b"),
    ("impersonate", r"\bimpersonat\w*\b"),
    ("criminal", r"\bcriminal\w*\b"),
    ("guilty", r"\bguilty\b"),
)
# Words that call something unlawful without accusing anyone in particular
# ("Army destroys 20 illegal refineries"). Attribution is needed only when
# the line also names someone who is not a public authority.
DESCRIPTIVE = _terms(("illegal", r"\b(?:illegal\w*|illicit\w*|unlawful\w*|unlicensed|counterfeit\w*|fake)\b"))
# Legal steps, reversals and decisions: the article must use the same word,
# with the same sense (not "denies" turned into "admitted", "not guilty" into
# "guilty", or "postponed" into "scrapped").
EVENTS = _terms(
    ("arrest", r"\barrest\w*\b"),
    ("arraign", r"\barraign\w*\b"),
    ("detain", r"\b(?:detain\w*|detention)\b"),
    ("remand", r"\bremand\w*\b"),
    ("convict", r"\bconvict(?:s|ed|ing|ion|ions)?\b"),
    ("sentence", r"\bsentenc\w*\b"),
    ("jail", r"\b(?:jail\w*|imprison\w*|prison term)\b"),
    ("indict", r"\bindict\w*\b"),
    ("prosecute", r"\bprosecut(?:e|es|ed|ing)\b"),
    ("charge", r"\bcharged\b|\b(?:\d+-count|fraud|criminal|corruption|murder|terrorism|money laundering|fresh|amended) charges?\b|\bcharges? (?:against|of)\b|\bon charges\b|\bcharge sheet\b"),
    ("plead", r"\bplead\w*\b|\bpled\b"),
    ("acquit", r"\bacquit\w*\b"),
    ("discharge", r"\bdischarg\w*\b"),
    ("admit", r"\b(?:admit(?:s|ted|ting)?|admission|confess\w*)\b"),
    ("deny", r"\b(?:denie[sd]|deny\w*|denial)\b"),
    ("sue", r"\b(?:sue|sues|sued|suing|lawsuit)\b"),
    ("freeze", r"\b(?:freez\w*|frozen)\b"),
    ("seize", r"\b(?:seiz\w*)\b"),
    ("wanted", r"\bdeclared? wanted\b"),
    ("sack", r"\b(?:sack\w*|fired)\b"),
    ("suspend", r"\bsuspen(?:d|ds|ded|ding|sion)\b"),
    ("dismiss", r"\bdismiss\w*\b"),
    ("resign", r"\bresign\w*\b"),
    ("impeach", r"\bimpeach\w*\b"),
    ("raid", r"\braid\w*\b"),
    ("postpone", r"\b(?:postpon\w*|defer(?:s|red|ring)?|delays|delayed)\b"),
    ("cancel", r"\b(?:cancel\w*|scrap(?:s|ped|ping)?|shelve[sd]?|shelving|halt\w*|call(?:s|ed)? off|abandon\w*|terminat\w*)\b"),
    ("withdraw", r"\b(?:withdraws|withdrew|withdrawn|withdrawing|pulls? out of|pulled out of)\b|\bwithdraw\b(?!al)"),
    ("revoke", r"\b(?:revok\w*|revocation|rescind\w*|overturn\w*|set aside|nullif\w*)\b"),
    ("approve", r"\b(?:approv\w*|ratif\w*)\b"),
    ("sign", r"\bsign(?:s|ed|ing)\b"),
    ("award", r"\bawarded\b|\bawards (?:a |the )?contract"),
)
_ATTRIBUTED = re.compile(
    r"\b(?:alleg\w*|according to|said|says|say|told|tells|tell|claim(?:s|ed)?|accus(?:ed|es|ing|ation|ations)|"
    r"testif\w*|reported(?:ly)?|report(?:s)? (?:said|say|says)|charged with|charge sheet)\b",
    re.I,
)
_NEGATION = re.compile(r"\b(?:not|no|never|yet to|without|denie[sd]|deny|denying|neither|nor|cannot|refutes?|rejects?)\b|n't\b", re.I)
# Public bodies that act against wrongdoing; naming them is not accusing them.
_AUTHORITIES = {
    "army", "navy", "police", "efcc", "icpc", "customs", "nafdac", "son", "dss", "ndlea", "nscdc",
    "court", "government", "ministry", "commission", "agency", "cbn", "sec", "ncc", "firs", "nupr",
    "nuprc", "nmdpra", "military", "troops", "operatives", "authorities", "officials", "federal",
}
SUPERLATIVES = re.compile(
    r"\b(?:largest|biggest|record-breaking|record high|record low|all-time|first-ever|unprecedented|historic)\b|\ba record\b",
    re.I,
)
ADVICE = re.compile(
    r"\b(?:you|investors|readers|traders|shareholders) should\b|\bshould (?:buy|sell|invest|hold|avoid)\b|"
    r"\b(?:buy|sell|hold) (?:rating|recommendation|signal)\b|\bprice target\b|\bstrong (?:buy|sell)\b|"
    r"\bwill (?:surge|crash|soar|plunge|rally|collapse)\b",
    re.I,
)
# Capitalised words that carry no claim (sentence starts, months, roles).
_COMMON = {
    "the", "a", "an", "this", "that", "it", "its", "if", "in", "on", "for", "of", "and", "to", "as",
    "with", "by", "at", "from", "under", "after", "while", "when", "who", "which", "their", "they",
    "nigeria", "nigerian", "nigerians", "federal", "government", "state", "president", "governor",
    "minister", "next", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "may", "june", "july", "august", "september",
    "october", "november", "december", "naira", "bn", "mn", "ceo", "md", "dg", "plc", "ltd",
}


def _negated(text: str, start: int) -> bool:
    """A negation within the four words before `start`, in the same clause."""
    before = re.split(r"[.;:!?,]", text[max(0, start - 60):start])[-1]
    return bool(_NEGATION.search(" ".join(before.split()[-4:])))


def _senses(pattern, text: str) -> set:
    """For each use of a term: True if affirmed, False if negated."""
    return {not _negated(text, m.start()) for m in pattern.finditer(text)}


def _same_sense(pattern, line: str, source: str) -> bool:
    """The term is in the source, and used there in the sense the line uses it."""
    in_line = _senses(pattern, line)
    if not in_line:
        return True
    in_source = _senses(pattern, source)
    return bool(in_source) and in_line <= in_source


def careful(line: str, source: str) -> bool:
    """No accusation, legal step, reversal, superlative or advice the source does not back.

    Wrongdoing words must be in the source and attributed in the line;
    legal steps and reversals must be in the source in the same sense
    ("pleaded not guilty" never becomes "pleaded guilty").
    """
    text = line or ""
    src = source or ""
    for _, pattern in ACCUSATORY:
        if pattern.search(text) and not (_same_sense(pattern, text, src) and _ATTRIBUTED.search(text)):
            return False
    for _, pattern in DESCRIPTIVE:
        if pattern.search(text):
            if not _same_sense(pattern, text, src):
                return False
            named = {n for n in names_in(text) if n not in _AUTHORITIES}
            if named and not _ATTRIBUTED.search(text):
                return False
    for _, pattern in EVENTS:
        if not _same_sense(pattern, text, src):
            return False
    for m in SUPERLATIVES.finditer(text):
        if m.group(0).lower() not in src.lower():
            return False
    return not ADVICE.search(text)


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
