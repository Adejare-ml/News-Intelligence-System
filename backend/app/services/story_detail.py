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


# A model describing its input instead of the news: "The article discusses
# ...", "..., though the reasons were not detailed in the provided text."
_META = re.compile(
    r"\b(?:the|this) (?:provided |given |source )?(?:article|text|snippet|report|excerpt|piece|story)\b"
    r"(?= (?:discuss|mention|describ|highlight|focus|state|note|report|says|does not|doesn't|lacks|is|was|provid))"
    r"|\bprovided (?:text|article|snippet|content)\b|\b(?:not|no) (?:detailed|specified|mentioned|stated|provided) in the\b",
    re.I,
)


def clean_summary(value: Any) -> str:
    """A summary that reports the news: a sentence about "the article" or
    "the provided text" loses that clause, or goes if nothing is left."""
    text = _SPACES.sub(" ", str(value or "")).strip()
    out = []
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if not _META.search(sentence):
            out.append(sentence)
            continue
        # "X happened, though the reasons were not detailed in the provided text."
        head = re.split(r",\s+(?:though|but|although|however|while|and)\s+", sentence)[0].rstrip(" ,;:.")
        if len(head.split()) >= 5 and not _META.search(head):
            out.append(head + ".")
    return " ".join(out).strip()


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
    r"(?:\s?(?P<scale>trillion|billion|million|thousand|trn|tr|tn|bn|mn|m|b|k)\b|(?P<t>t)\b)?"
    r"(?:\s?(?P<pct>%|per\s?cent\b|percent\b))?"
    r"(?:\s(?P<cur2>(?:u\.?s\.? |us |american )?dollars?|(?:nigerian )?naira|pounds?(?: sterling)?|euros?)\b)?",
    re.I,
)
_CURRENCIES = {
    "us$": "USD", "$": "USD", "usd": "USD",
    "₦": "NGN", "n": "NGN", "ngn": "NGN",
    "£": "GBP", "€": "EUR",
}
_SCALES = {
    "k": 3, "thousand": 3, "m": 6, "mn": 6, "million": 6,
    "b": 9, "bn": 9, "billion": 9, "t": 12, "tn": 12, "tr": 12, "trn": 12, "trillion": 12,
}
# Counts written as words ("five directors"); "one" is left alone, it is
# too often not a count.
_NUMBER_WORDS = {
    "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20, "dozen": 12,
    "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}
_UNITS = {k: v for k, v in _NUMBER_WORDS.items() if v < 10}
_NUMBER_WORD = re.compile(
    r"\b(thirty|forty|fifty|sixty|seventy|eighty|ninety)-(" + "|".join(_UNITS) + r")\b"
    r"|\b(" + "|".join(_NUMBER_WORDS) + r")\b",
    re.I,
)


def _number_word(m) -> str:
    if m.group(1):
        return str(_NUMBER_WORDS[m.group(1).lower()] + _NUMBER_WORDS[m.group(2).lower()])
    return str(_NUMBER_WORDS[m.group(3).lower()])


def _currency(m) -> str:
    cur = (m.group("cur") or "").strip().lower()
    if cur:
        return _CURRENCIES.get(cur, "")
    word = (m.group("cur2") or "").lower()
    if "dollar" in word:
        return "USD"
    if "naira" in word:
        return "NGN"
    if "pound" in word:
        return "GBP"
    if "euro" in word:
        return "EUR"
    return ""


def amounts_in(text: str) -> set:
    """Figures as (kind, value): kind is a currency code, '%' or '' (a bare number)."""
    text = _NUMBER_WORD.sub(_number_word, text or "")
    out = set()
    for m in _AMOUNT.finditer(text):
        try:
            value = Decimal(m.group("num").replace(",", ""))
        except InvalidOperation:
            continue
        scale = (m.group("scale") or m.group("t") or "").lower()
        value = value.scaleb(_SCALES.get(scale, 0)).normalize()
        kind = "%" if m.group("pct") else _currency(m)
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
    if kind == "%":
        return item in source_amounts
    # A currency figure; the source may give the same figure without its currency.
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


# Words that state wrongdoing. Allowed only when the article uses the word,
# in the same sense, with the same people, and the line attributes it in the
# same sentence ("alleged", "according to", "said").
ACCUSATORY = _terms(
    ("fraud", r"\b(?:fraud\w*|defraud\w*)\b"),
    ("corrupt", r"\bcorrupt\w*\b"),
    ("embezzle", r"\bembezzl\w*\b"),
    ("launder", r"\blaunder\w*\b"),
    ("loot", r"\bloot\w*\b"),
    ("steal", r"\b(?:stole|stolen|steal\w*|thief|thieves|thieve\w*)\b|(?<!crude )(?<!oil )(?<!energy )(?<!power )(?<!fuel )(?<!pipeline )(?<!identity )(?<!cyber )\btheft\b"),
    ("divert", r"\b(?:divert\w*|diversion)\b"),
    ("misappropriate", r"\b(?:misappropriat\w*|misappl\w*)\b"),
    ("convert", r"\bconvert(?:ed|ing|s)? (?:\w+ )?(?:funds?|money|proceeds|cash) to\b|\bconversion of (?:\w+ )?funds\b"),
    ("siphon", r"\bsiphon\w*\b"),
    ("bribe", r"\b(?:brib\w*|kick-?backs?)\b"),
    ("graft", r"(?<!anti-)\bgraft\b"),
    ("inflate", r"\b(?:inflated|inflating|over-?invoic\w*|padd(?:ed|ing))\b|\b(?:contract|budget|cost|price|invoice) inflation\b"),
    ("cheat", r"\bcheat\w*\b"),
    ("pretence", r"\bfalse pretences?\b|\bobtain\w* (?:money|funds|property) by\b"),
    ("conspire", r"\bconspir\w*\b"),
    ("wrongdoing", r"\bwrongdoing\b|\bmisconduct\b|\bmalfeasance\b|\bimpropriet\w*\b|\bmalpractice\w*\b|\bsharp practices?\b"),
    ("irregular", r"\birregularit\w*\b"),
    ("conflict of interest", r"\bconflicts? of interest\b"),
    ("nepotism", r"\bnepotis\w*\b|\bfavou?ritism\b"),
    ("rig", r"\brig(?:ged|ging)\b"),
    ("scam", r"\bscam\w*\b"),
    ("cover-up", r"\bcover-?ups?\b"),
    ("crony", r"\bcron(?:y|ies|yism)\b"),
    ("extort", r"\bextort\w*\b"),
    ("ponzi", r"\bponzi\b"),
    ("mismanage", r"\bmismanag\w*\b"),
    ("abuse of office", r"\babuse of (?:office|power)\b"),
    ("forge", r"\bforg(?:ed|ery|eries)\b"),
    ("impersonate", r"\bimpersonat\w*\b"),
    ("guilty", r"\bguilty\b"),
)
# Words that call something unlawful without accusing anyone in particular
# ("Army destroys 20 illegal refineries", "crude theft"). The source must use
# them, with the same people.
DESCRIPTIVE = _terms(
    ("illegal", r"\b(?:illegal\w*|illicit\w*|unlawful\w*|unlicensed|counterfeit\w*|fake)\b"),
    ("theft", r"\b(?:crude|oil|energy|power|fuel|pipeline|identity|cyber) theft\b"),
)
# Legal and enforcement steps: in the source, in the same sense ("not
# charged" never "charged", "will be charged" never "was charged"), and with
# the same people in the same roles.
LEGAL = _terms(
    ("arrest", r"\barrest(?:s|ed|ing)?\b(?! (?:the|its|a) (?:decline|slide|fall|drop|trend))|\b(?:nab\w*|apprehend\w*)\b"),
    ("arraign", r"\barraign\w*\b|\bdock(?:ed|s)?\b|\bin the dock\b"),
    ("detain", r"\b(?:detain\w*|detention|in custody)\b"),
    ("remand", r"\bremand\w*\b"),
    ("convict", r"\bconvict(?:s|ed|ing|ion|ions)?\b"),
    ("sentence", r"\bsentenc\w*\b"),
    ("jail", r"\b(?:jail\w*|imprison\w*|prison term)\b"),
    ("indict", r"\bindict\w*\b"),
    ("prosecute", r"\bprosecut(?:e|es|ed|ing|ion)\b"),
    ("charge", r"\bcharged\b|\bcharges? (?:\w+ )?with\b|\b(?:\d+-count|\w+-count|fraud|criminal|corruption|murder|terrorism|money laundering|fresh|amended) charges?\b|\bcharges? (?:against|of)\b|\bon charges\b|\bcharge sheet\b|\bfaces? charges\b"),
    ("plead", r"\bplead\w*\b|\bpled\b"),
    ("acquit", r"\bacquit\w*\b|\bexonerat\w*\b|\babsolv\w*\b"),
    ("discharge", r"\bdischarg\w*\b"),
    ("quash", r"\bquash\w*\b"),
    ("trial", r"(?<!clinical )\btrials?\b(?! run)|\bstands? trial\b"),
    ("sue", r"\b(?:sue|sues|sued|suing|lawsuit)\b"),
    ("freeze", r"\b(?:freez\w*|frozen)\b"),
    ("seize", r"\b(?:seiz\w*)\b"),
    ("forfeit", r"\bforfeit\w*\b"),
    ("extradite", r"\bextradit\w*\b"),
    ("blacklist", r"\bblacklist\w*\b"),
    ("fine", r"\bfined\b|\bimpos\w* (?:a )?fines?\b|\bfines? of\b"),
    ("sanction", r"\bsanction\w*\b"),
    ("wanted", r"\bdeclared? wanted\b|\bwanted list\b"),
    ("raid", r"\braid\w*\b"),
    ("probe", r"\bprob(?:e|es|ed|ing)\b|\binvestigat\w*\b|\binquiry\b|\bunder investigation\b"),
    ("quiz", r"\b(?:quiz\w*|grill\w*|interrogat\w*)\b"),
    ("impeach", r"\bimpeach\w*\b"),
    ("criminal", r"\bcriminal\w*\b"),
    ("allege", r"\balleg\w*\b|\baccus(?:ed|es|ing|ation|ations)\b"),
)
# Other events: in the source, in the same sense ("has not approved" never
# "approved", "denies" never "admitted", "postponed" never "scrapped").
EVENTS = LEGAL + _terms(
    ("admit", r"\b(?:admit(?:s|ted|ting)?|admission|confess\w*|concede\w*|acknowledg\w*)\b"),
    ("deny", r"\b(?:denie[sd]|deny\w*|denial)\b"),
    ("confirm", r"\bconfirm(?:s|ed|ing)?\b"),
    ("sack", r"\bsack\w*\b"),
    ("suspend", r"\bsuspen(?:d|ds|ded|ding|sion)\b"),
    ("dismiss", r"\bdismiss\w*\b"),
    ("resign", r"\bresign\w*\b"),
    ("postpone", r"\b(?:postpon\w*|defer(?:s|red|ring)?|delays|delayed|on hold)\b"),
    ("cancel", r"\b(?:cancel\w*|scrap(?:s|ped|ping)?|shelve[sd]?|shelving|halt\w*|call(?:s|ed)? off|abandon\w*|terminat\w*|drop(?:s|ped)|ax(?:es|ed)|ditch\w*|kill(?:s|ed)|stop(?:s|ped)|pull(?:s|ed)? the plug|back(?:s|ed)? out|void(?:s|ed)?|annul\w*)\b"),
    ("withdraw", r"\b(?:withdraws|withdrew|withdrawn|withdrawing|pulls? out of|pulled out of)\b|\bwithdraw\b(?!al)"),
    ("revoke", r"\b(?:revok\w*|revocation|rescind\w*|overturn\w*|set aside|nullif\w*)\b"),
    ("approve", r"\b(?:approv\w*|ratif\w*)\b"),
    ("sign", r"\bsign(?:s|ed|ing)\b"),
    ("award", r"\bawarded\b|\bawards (?:a |the )?contract"),
    ("complete", r"\bcomplet(?:e|es|ed|ing|ion)\b"),
    ("list", r"\blist(?:s|ed|ing)? on\b|\bdebut\w*\b|\bgoes public\b|\bwent public\b"),
)
# Accusation and legal words: a line using one must be backed by ONE source
# sentence that names the same people with it.
SENSITIVE = ACCUSATORY + DESCRIPTIVE + LEGAL
_ATTRIBUTED = re.compile(
    r"\b(?:alleg\w*|according to|said|says|say|told|tells|tell|claimed|accused (?:of|by)|accuses|accusing|"
    r"accusations?|testif\w*|reported(?:ly)?|charged with|charge sheet)\b",
    re.I,
)
# An acquittal or clearance: the wrongdoing word names what was NOT proved.
_CLEARED = re.compile(r"\bacquit\w*|\bcleared? of\b|\bclears\b|\bdischarg\w*|\bnot guilty\b|\bexonerat\w*|\babsolv\w*|\bquash\w*", re.I)
_NEGATION = re.compile(
    r"\b(?:not|no|never|nobody|none|nothing|yet to|without|denie[sd]|deny|denying|neither|nor|cannot|"
    r"refutes?|refuted|rejects?|rejected|fails? to|failed to)\b|n['’]t\b",
    re.I,
)
_CONDITION = re.compile(
    r"\b(?:if|whether|may|might|could|would|will|shall|to|plans?|planned|set|expected|likely|seeks?|sought|"
    r"wants?|threatens?|threatened|vows?|vowed|moves?|bid|attempt\w*|urges?|urged|calls? for|asks?|asked)\b",
    re.I,
)
# Public bodies that act against wrongdoing; naming them is not accusing them.
_AUTHORITIES = {
    "army", "navy", "police", "efcc", "icpc", "customs", "nafdac", "son", "dss", "ndlea", "nscdc",
    "court", "high", "appeal", "supreme", "justice", "judge", "government", "ministry", "commission",
    "agency", "cbn", "sec", "ncc", "firs", "nuprc", "nmdpra", "military", "troops", "operatives",
    "authorities", "officials", "federal", "economic", "financial", "crimes", "independent", "practices",
    "related", "offences", "other", "national", "bureau", "council", "service", "nigeria", "nigerian",
    "nigerians", "lagos", "abuja", "state", "senate", "house", "representatives", "assembly", "fct",
    # Places are not parties.
    "abia", "adamawa", "akwa", "ibom", "anambra", "bauchi", "bayelsa", "benue", "borno", "cross", "river",
    "rivers", "delta", "ebonyi", "edo", "ekiti", "enugu", "gombe", "imo", "jigawa", "kaduna", "kano",
    "katsina", "kebbi", "kogi", "kwara", "nasarawa", "niger", "ogun", "ondo", "osun", "oyo", "plateau",
    "sokoto", "taraba", "yobe", "zamfara", "port", "harcourt", "ibadan", "benin", "jos", "calabar",
    "warri", "onitsha", "aba", "ikeja", "lekki", "africa", "african", "west", "united", "states", "uk",
}
SUPERLATIVES = re.compile(
    r"\b(?:largest|biggest|record-breaking|record high|record low|all-time|first-ever|unprecedented|historic)\b|\ba record\b",
    re.I,
)
ADVICE = re.compile(
    r"\b(?:you|investors|readers|traders|shareholders) should\b|\bshould (?:buy|sell|invest|hold|avoid|dump)\b|"
    r"\b(?:buy|sell|hold|dump|avoid|accumulate) (?:\w+ )?(?:shares|stocks?|bonds?|equities)\b|\bis a (?:strong )?(?:buy|sell)\b|"
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
    # Words that open a sentence without naming anyone.
    "earlier", "reports", "report", "analysts", "both", "all", "some", "most", "many", "several", "other",
    "others", "new", "his", "her", "our", "we", "he", "she", "there", "these", "those", "but", "however",
    "also", "meanwhile", "still", "yet", "despite", "although", "though", "because", "since", "according",
    "separately", "elsewhere", "today", "yesterday", "last", "first", "more", "what", "why", "how", "where",
    "two", "three", "four", "five", "officials", "sources", "critics", "residents", "experts", "lawmakers",
}
_SENTENCE = re.compile(r"(?<=[.!?;])\s+|\n+|\s+\|\s+")


def _sentences(text: str) -> List[str]:
    return [x.strip() for x in _SENTENCE.split(text or "") if x.strip()]


def _sense(text: str, start: int) -> str:
    """How a term at `start` is used: 'no' (negated), 'if' (conditional or
    future) or 'yes', from the five words before it in the same clause."""
    before = re.split(r"[.;:!?,]", text[max(0, start - 70):start])[-1]
    window = " ".join(before.split()[-5:])
    if _NEGATION.search(window):
        return "no"
    if _CONDITION.search(window):
        return "if"
    return "yes"


def _negated(text: str, start: int) -> bool:
    return _sense(text, start) == "no"


def _senses(pattern, text: str) -> set:
    return {_sense(text, m.start()) for m in pattern.finditer(text)}


def _same_sense(pattern, line: str, source: str) -> bool:
    """The term is in the source, and used there in the sense the line uses it."""
    in_line = _senses(pattern, line)
    if not in_line:
        return True
    in_source = _senses(pattern, source)
    return bool(in_source) and in_line <= in_source


def _party_names(text: str) -> set:
    return {n for n in names_in(text) if n not in _AUTHORITIES}


def _anchored(pattern, line: str, source: str) -> bool:
    """One source sentence uses the term with every person or company the
    line names; when the line puts parties on both sides of the term ("X sues
    Y"), the sentence must too, in the same order."""
    names = _party_names(line)
    m = pattern.search(line)
    before = {n for n in names if n in _party_names(line[:m.start()])}
    after = {n for n in names if n in _party_names(line[m.end():])} - before
    two_sided = bool(before) and bool(after)
    sentences = _sentences(source)
    # A sentence and the one before it, so "he pleaded not guilty" can find
    # the defendant named a sentence earlier.
    for i, sentence in enumerate(sentences):
        if i:
            sentence = sentences[i - 1] + " " + sentence
        words = _words(sentence)
        if not all(all(p in words for p in re.findall(r"[a-z0-9]+", n)) for n in names):
            continue
        for hit in pattern.finditer(sentence):
            if not two_sided:
                return True
            left, right = _words(sentence[:hit.start()]), _words(sentence[hit.end():])
            if all(all(p in left for p in re.findall(r"[a-z0-9]+", n)) for n in before) and \
                    all(all(p in right for p in re.findall(r"[a-z0-9]+", n)) for n in after):
                return True
    return False


def careful(line: str, source: str) -> bool:
    """No accusation, legal step, reversal, superlative or advice the source does not back.

    Wrongdoing and legal words must be in the source in the same sense and
    in one sentence with the same people; wrongdoing must also be attributed
    in the line's own sentence. Other events must be in the source in the
    same sense ("pleaded not guilty" never becomes "pleaded guilty").
    """
    text = line or ""
    src = source or ""
    if ADVICE.search(text):
        return False
    for m in SUPERLATIVES.finditer(text):
        if m.group(0).lower() not in src.lower():
            return False
    for _, pattern in EVENTS:
        if not _same_sense(pattern, text, src):
            return False
    cleared = bool(_CLEARED.search(text))
    for _, pattern in ACCUSATORY:
        if not pattern.search(text):
            continue
        if not _same_sense(pattern, text, src) or not _anchored(pattern, text, src):
            return False
        if not cleared and not any(pattern.search(x) and _ATTRIBUTED.search(x) for x in _sentences(text)):
            return False
    for _, pattern in DESCRIPTIVE:
        if not pattern.search(text):
            continue
        if not (_same_sense(pattern, text, src) and _anchored(pattern, text, src)):
            return False
        # Calling a named firm's or person's activity unlawful is an accusation.
        if _party_names(text) and not cleared and not _ATTRIBUTED.search(text):
            return False
    for _, pattern in LEGAL:
        if pattern.search(text) and not (_same_sense(pattern, text, src) and _anchored(pattern, text, src)):
            return False
    return True


_STOPWORDS = {
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "with", "as", "at", "by", "from", "over",
    "its", "his", "her", "their", "has", "have", "had", "was", "were", "is", "are", "be", "been", "will",
    "that", "this", "which", "who", "it", "into", "than", "also", "after", "before", "said", "says",
}
_POLARITY = (_NEGATION, _CLEARED, re.compile(r"\b(?:denie[sd]|deny\w*|denial|refut\w*)\b", re.I))


def _stem(word: str) -> str:
    for suffix in ("ing", "ed", "es", "s"):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[: -len(suffix)]
    return word


def _content(text: str) -> set:
    return {_stem(w) for w in re.findall(r"[a-z0-9₦$%.]+", (text or "").lower()) if w not in _STOPWORDS and len(w) > 2}


def extractive(line: str, source: str, threshold: float = 0.75) -> bool:
    """The line restates one source sentence: most of its words are in that
    sentence, and it keeps that sentence's "not", "denies" or "cleared of"
    (and adds none of its own)."""
    words = _content(line)
    if not words:
        return False
    for sentence in _sentences(source):
        if len(words & _content(sentence)) / len(words) < threshold:
            continue
        if all(bool(p.search(line)) == bool(p.search(sentence)) for p in _POLARITY):
            return True
    return False


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
    unattributed accusation, and a fact that does not restate one sentence
    of the article: an empty field is better than an invented one.
    """
    analysis = analysis or {}
    basis = "\n".join(x for x in (title, source_text) if x)
    # A key fact is shown as a fact, so it must restate one sentence of the
    # article, not paraphrase several.
    facts = [
        f for f in clean_facts(analysis.get("key_facts"), analysis.get("summary") or "")
        if grounded(f, basis) and careful(f, basis) and (not source_text or extractive(f, basis))
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
