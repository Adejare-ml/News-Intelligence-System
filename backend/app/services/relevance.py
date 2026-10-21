"""Deterministic topical relevance guard.

Relevance used to be decided by a single boolean from the language model, and
`run_pipeline` read it as ``analysis.get("relevant", True)`` — so a missing key
published the article. That is a filter that fails open.

This module is the deterministic check that sits behind the model. It answers
one narrow question: *is this story about sport or celebrity entertainment
rather than corporate ownership?* Those are the two domains that leaked most
visibly (a football transfer was published at risk 40 under category
"Company"), and they are the two where a keyword signal is genuinely reliable.

Deliberately narrow. The guard does **not** try to adjudicate politics,
security or general news; the model's prompt already covers those, and they sit
close enough to the corporate domain that a keyword rule would remove real
ownership signal. Precision matters more than recall here: publishing a sports
story is embarrassing, but dropping a beneficial-ownership disclosure defeats
the product.

Three properties make it safe to run over everything:

* **Word-boundary matching.** Substring matching would filter "Golfview
  Estates" on "golf" and "FCMB" on "fc".
* **An ownership override.** Explicit corporate-governance language wins
  outright, so "Dangote acquires 60% stake in a football club" stays.
* **It never raises.** Malformed input returns False rather than taking down a
  scheduled run.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable

# ---------------------------------------------------------------------------
# Vocabularies
# ---------------------------------------------------------------------------

# Terms that are essentially never used in a corporate-ownership story except
# as the subject matter itself. "manager", "director" and "chairman" are
# pointedly absent: they are core corporate vocabulary.
_SPORT_TERMS = (
    "football", "soccer", "basketball", "volleyball", "cricket", "rugby",
    "tennis", "golfer", "boxing", "wrestling", "athletics", "marathon",
    "olympics", "olympic", "afcon", "world cup", "premier league", "la liga",
    "serie a", "bundesliga", "champions league", "europa league",
    # "nba" and "caf" are deliberately absent. In Nigerian reporting NBA is
    # overwhelmingly the *Nigerian Bar Association* — it appears 14 times in
    # this dataset, attached to people recorded as officers — and filtering on
    # it would drop legitimate professional-body governance coverage. CAF is
    # similarly ambiguous, and "Confederation of African Football" is caught by
    # "football" anyway.
    "mls", "nfl", "uefa", "fifa", "nff", "npfl",
    "super eagles", "super falcons", "flying eagles",
    "striker", "midfielder", "goalkeeper", "defender", "winger", "footballer",
    "centre-back", "left-back", "right-back", "penalty", "offside",
    "kick-off", "kickoff", "half-time", "full-time", "transfer window",
    "friendly match", "international friendly", "qualifier", "derby",
    "league table", "fixture list",
    "scored", "scores twice", "hat-trick", "substitute",
    "football club", "sports club", "fc",
)

_ENTERTAINMENT_TERMS = (
    "nollywood", "bbnaija", "big brother naija", "grammy", "amvca", "afrobeats",
    "movie", "film premiere", "box office", "album", "singer", "songwriter",
    "actress", "actor", "musician", "rapper", "skit maker", "influencer",
    "reality show", "housemate", "housemates", "eviction", "red carpet",
    "star-studded", "celebrity", "wedding", "engagement party", "birthday bash",
    "music video", "concert", "tour dates",
)

# Structural and regulatory language: evidence that the article is reporting
# on corporate ownership itself. Any one of these outranks the topic signal,
# because a shareholding story is in scope whatever the underlying asset is.
_OWNERSHIP_STRONG_TERMS = (
    "shareholding", "shareholder", "shareholders", "stake", "equity",
    "beneficial owner", "beneficial ownership", "significant control", "psc",
    "share capital", "issued shares", "voting rights",
    "board of directors", "board seat", "annual return", "filing",
    "cac", "sec", "cbn", "naicom", "frc", "corporate affairs commission",
    "securities and exchange commission",
    "dividend", "ipo", "listing", "delisting", "rights issue",
    "subsidiary", "holding company", "holdco", "parent company",
    "incorporated", "liquidation", "receivership", "insolvency",
    "procurement", "contract award", "tender",
)

# Transactional verbs. These are *not* enough on their own.
#
# "acquisition" was originally treated as strong, and it silently readmitted
# the story that prompted this guard: a football-transfer piece whose summary
# read "pursuing the acquisition of a football club". Any purchase is an
# acquisition; the word says nothing about whether the article is corporate
# reporting. It counts only alongside a strong term or an explicit percentage.
_OWNERSHIP_WEAK_TERMS = (
    "acquisition", "acquires", "acquired", "merger", "merges", "merged",
    "takeover", "divestment", "divests", "buyout", "controlling interest",
)


def _compile(terms: Iterable[str]) -> re.Pattern:
    """Word-boundary alternation over the vocabulary, longest term first.

    Longest-first ordering matters so that "football club" is reported rather
    than the bare "football" it contains.
    """
    ordered = sorted(set(terms), key=len, reverse=True)
    return re.compile(r"\b(" + "|".join(re.escape(t) for t in ordered) + r")\b")


_SPORT_RE = _compile(_SPORT_TERMS)
_ENTERTAINMENT_RE = _compile(_ENTERTAINMENT_TERMS)
_OWNERSHIP_STRONG_RE = _compile(_OWNERSHIP_STRONG_TERMS)
_OWNERSHIP_WEAK_RE = _compile(_OWNERSHIP_WEAK_TERMS)

# "60%", "60 per cent", "60 percent" — a quantified holding turns a bare
# transactional verb into a real ownership claim.
#
# The word-boundary anchor goes on the spelled-out forms only: "%" is not a
# word character, so a trailing \b after it can never match before a space,
# and "acquires 60% of" would silently fail to register.
_PERCENTAGE_RE = re.compile(r"\b\d{1,3}(?:\.\d+)?\s*(?:%|per\s?cent\b|percent\b)")

# A scoreline such as "2-2" or "3-1" is a strong corroborating sport signal,
# but far too generic to stand on its own (financial copy is full of ranges).
_SCORELINE_RE = re.compile(r"\b\d{1,2}\s*[-–]\s*\d{1,2}\b")

# A match report reads "X beat Y 2-0". Neither half is conclusive alone — a
# result verb is ordinary English and a scoreline is ordinary numerals — but
# together they are a reliable sport signal that needs no team vocabulary.
_RESULT_VERB_RE = re.compile(
    r"\b(beat|beats|defeat|defeats|defeated|thrash|thrashed|draw|drew|"
    r"held|edge|edged|trounced|hammered)\b"
)


@dataclass(frozen=True)
class OffTopicReason:
    """Why an article was judged off-topic, kept for the run log."""

    topic: str
    matched: list[str] = field(default_factory=list)


def _normalise(*parts: Any) -> str:
    text = " ".join(str(p) for p in parts if isinstance(p, str))
    # Curly apostrophes appear throughout the feeds and would break \b matching
    # on possessives.
    return text.replace("’", "'").lower()


def off_topic_reason(title: Any, summary: Any = None) -> OffTopicReason | None:
    """Return why the article is off-topic, or None when it is in scope.

    Never raises: any unexpected input is treated as in-scope, so the guard can
    only ever be a no-op rather than a source of pipeline failures.
    """
    try:
        text = _normalise(title, summary)
        if not text.strip():
            return None

        # Structural ownership language wins outright. A transactional verb
        # only counts when it is quantified — "acquires 60% of" is a corporate
        # story, "pursuing the acquisition of" is any purchase at all.
        if _OWNERSHIP_STRONG_RE.search(text):
            return None
        if _OWNERSHIP_WEAK_RE.search(text) and _PERCENTAGE_RE.search(text):
            return None

        sport = _SPORT_RE.findall(text)
        entertainment = _ENTERTAINMENT_RE.findall(text)

        # A scoreline corroborates, and paired with a result verb it stands on
        # its own -- that is the shape of a match report with no team named.
        if _SCORELINE_RE.search(text):
            if sport:
                sport = sport + ["scoreline"]
            elif _RESULT_VERB_RE.search(text):
                sport = ["scoreline", "result verb"]

        if sport:
            return OffTopicReason("sport", sorted(set(sport)))
        if entertainment:
            return OffTopicReason("entertainment", sorted(set(entertainment)))
        return None
    except Exception:  # pragma: no cover - defensive
        return None


def is_off_topic(title: Any, summary: Any = None) -> bool:
    """True when the article is about sport or celebrity entertainment."""
    return off_topic_reason(title, summary) is not None


# ---------------------------------------------------------------------------
# Publication and page-furniture guard
# ---------------------------------------------------------------------------
#
# Moved here from run_pipeline so it can be used without importing the LLM and
# spaCy stack. It is the same kind of deterministic guard as the topic check
# above, and the extraction metric in evals/ needs it to score "listed the
# newspaper as a party to the story" -- a check that has to run in tests with no
# network and no models. run_pipeline re-exports it, so existing imports and
# tests/test_entity_filter.py are unaffected.

# Three matching strengths, because a bare substring test dropped real
# companies: "tribune" matched "Industrial Tribunal", "the nation" matched
# "The National Pension Commission", and "guardian" matched "Guardian Life
# Assurance Plc" -- none of which is a newspaper.

# Domain-style handles: these only ever appear as (part of) an outlet's web
# name, so plain substring stays correct ("dailypost", "www.thecable.ng").
DOMAIN_OUTLET_MARKERS = (
    "dailypost", "thecable", "legit.ng", "nairametrics", "businessday",
)

# Distinctive outlet names: safe anywhere in the string, but only as whole
# words ("bbc" must not fire inside an unrelated token).
DISTINCT_OUTLET_MARKERS = (
    "premium times", "daily post", "thisday", "channels tv",
    "channels television", "leadership newspaper", "business day",
    "sahara reporters", "peoples gazette", "the cable",
    "reuters", "bloomberg", "associated press", "al jazeera", "bbc", "cnn",
)

# Ordinary words that are outlet names only when the *whole* name is the
# outlet: the marker plus generic outlet qualifiers. "Punch Newspapers" and
# "The Guardian Nigeria News" are publications; "Guardian Life Assurance
# Plc" and "Punch Bowl Ltd"-style names carry non-qualifier words and stay.
AMBIGUOUS_OUTLET_MARKERS = (
    "guardian", "punch", "vanguard", "tribune", "the nation", "this day",
)

_OUTLET_QUALIFIERS = {
    "the", "nigeria", "nigerian", "news", "newspaper", "newspapers",
    "online", "ng", "media", "daily", "ltd", "limited",
}

# Kept as the combined tuple for existing importers (run_pipeline re-exports
# it; tests iterate it to build fixtures).
NEWS_OUTLET_MARKERS = DOMAIN_OUTLET_MARKERS + DISTINCT_OUTLET_MARKERS + AMBIGUOUS_OUTLET_MARKERS

# Navigation furniture scraped from article pages.
NON_ENTITY_TERMS = {
    "archives", "archive", "home", "newsletter", "advertisement", "sponsored",
    "read more", "subscribe", "latest news", "breaking news", "news",
}

# What the extractor writes into a Name field when the article never named
# anyone. These reached the dashboard as people: the appointments board
# rendered "Unknown left Speaker @ Edo State House of Assembly" and linked
# it to a person dossier, and the entity directory carried "Not Specified"
# as a tracked individual. They are the absence of a name, not a name.
#
# "Unnamed Commissioner" is deliberately NOT here. It is the same absence,
# but it carries the role, so the move is still worth recording -- the
# dashboard renders those without a dossier link instead of dropping them.
PLACEHOLDER_PERSON_NAMES = {
    "unknown", "unknowns", "unidentified", "none", "no name", "nobody",
    "n/a", "na", "nil", "null", "nan", "tbd", "tba", "anonymous", "unnamed",
    "not specified", "unspecified", "not stated", "not disclosed",
    "undisclosed", "not available", "not known", "not named",
    "not mentioned", "not applicable", "not provided", "not reported",
}


# The other way a Name field ends up holding something that is not a person:
# the extractor captures the post instead of the holder ("Managing
# Director/Chief Executive", "Officers Commanding"), abbreviates the post
# plus the organisation's initials ("MD NAN", "DG NTA"), or lifts an
# organisation or a headline fragment outright ("Kogi Forum", "Rafa
# Corporation Accelerates Growth").
#
# Precision matters far more than recall here. 43% of the moves board is a
# real person referred to by surname alone -- "Cardoso", "Orya", "Agbebaku"
# -- so a rule that treats a thin name as a bad one would delete most of
# the board. Every rule below therefore fires on what the name *is made
# of*, never on how much of it there is. Measured over the 440 distinct
# names in the live people.json, the three together flag six, all six
# genuinely not people, and leave "Prof Gombe" and "Capt. Wisdom" alone.
_ROLE_WORDS = {
    "managing", "director", "directors", "general", "chief", "executive",
    "officer", "officers", "commanding", "deputy", "acting", "interim",
    "assistant", "administrator", "chairman", "chairperson", "chair",
    "president", "vice", "secretary", "treasurer", "registrar", "provost",
    "rector", "commissioner", "comptroller", "controller", "commandant",
    "coordinator", "manager", "head", "boss", "spokesperson", "aide",
    "representative", "delegate", "envoy", "consul", "ambassador",
    "minister", "governor", "senator", "speaker", "dean", "principal",
    "supervisor", "inspector", "auditor", "counsel", "advisor", "adviser",
}

# Words that carry no identity, so they do not stop a name being all-role.
_NAME_FILLER = {"and", "of", "the", "for", "to", "a", "an", "at", "in", "on"}

# Posts that get abbreviated in front of an organisation's initials.
_TITLE_ACRONYMS = {"md", "dg", "ceo", "cfo", "coo", "cto", "gmd", "ed"}

# Institutional words. Distinct from the outlet markers above: those catch
# the publication, these catch the subject organisation.
_ORG_WORDS = {
    "forum", "association", "agency", "commission", "authority", "council",
    "ministry", "bureau", "institute", "federation", "union", "party",
    "corps", "command", "academy", "bank", "plc", "ltd", "limited",
    "company", "corporation", "group", "committee", "board", "department",
    "society", "congress", "assembly", "parliament", "senate", "tribunal",
    "secretariat", "organisation", "organization", "foundation", "trust",
    "university", "college", "school", "hospital", "church", "mosque",
}


def _name_tokens(name: Any, split_hyphens: bool = False) -> list:
    """Lowercased word tokens, with separators and edge punctuation gone.

    Hyphens split only for the all-role rule, which needs "Director-General"
    to read as two role words. The organisation rule must not split them:
    it fires on a single token, and a hyphenated Nigerian surname such as
    "Bank-Olemoh" would hand it one.
    """
    cleaned = " ".join(str(name or "").replace("\xa0", " ").split()).lower()
    cleaned = re.sub(r"[/,]", " ", cleaned)
    if split_hyphens:
        cleaned = re.sub(r"[-‐-―]", " ", cleaned)
    out = []
    for token in cleaned.split():
        token = re.sub(r"^[^\w]+|[^\w]+$", "", token)
        if token:
            out.append(token)
    return out


def is_role_or_org_name(name: Any) -> bool:
    """True when a Name field holds a job title or an organisation, not a person."""
    tokens = _name_tokens(name)
    if not tokens:
        return False

    # A post with no holder: every word is title vocabulary.
    meaningful = [t for t in _name_tokens(name, split_hyphens=True)
                  if t not in _NAME_FILLER]
    if meaningful and all(t in _ROLE_WORDS for t in meaningful):
        return True

    # "MD NAN" / "DG NTA": a post abbreviation then an all-caps acronym.
    # The second word is checked in its original case, because "Dg Nta"
    # would be a surname pair and this pattern is specifically the
    # newsroom shorthand.
    raw = str(name or "").split()
    if len(tokens) == 2 and len(raw) == 2 and tokens[0] in _TITLE_ACRONYMS:
        second = re.sub(r"^[^\w]+|[^\w]+$", "", raw[1])
        if re.fullmatch(r"[A-Z]{2,6}", second):
            return True

    # An organisation standing where a person should be.
    return any(t in _ORG_WORDS for t in tokens)


def is_unevidenced_officer(position: Any) -> bool:
    """True for the bare "Officer" the retired heuristic fallback stamped on
    every person it found.

    It is a fingerprint, not a job title. The fallback (see
    ``LLMService._run_local_fallback``) gave each person "Officer" plus the
    article's first organisation, neither of them a finding, so a row
    carrying it has an invented Organization too. 93% of July's rows read
    this way and none since September, which is when that path stopped
    running -- the model names a real post or leaves it blank.

    Exact match only: "Chief Security Officer" and "Information Officer"
    are real posts and must survive.
    """
    cleaned = " ".join(str(position or "").replace("\xa0", " ").split()).lower()
    return cleaned == "officer"


def is_placeholder_person(name: Any) -> bool:
    """True when a Name field holds a "no name was given" marker, not a person.

    Applied at export (``run_pipeline``) rather than at write time, so the
    sheet keeps its audit trail exactly as the other entity guards here do.
    """
    cleaned = " ".join(str(name or "").replace("\xa0", " ").split()).lower()
    # Strip the punctuation these arrive wrapped in ("(unknown)", "N/A.",
    # "--"), which also collapses a bare dash or question mark to "".
    cleaned = re.sub(r"^[^\w]+|[^\w]+$", "", cleaned)
    return not cleaned or cleaned in PLACEHOLDER_PERSON_NAMES


def _word_bounded(marker: str, cleaned: str) -> bool:
    return re.search(r"\b" + re.escape(marker) + r"\b", cleaned) is not None


def is_publication_or_furniture(name: Any) -> bool:
    """True when an extracted organization is really the publication or page chrome."""
    cleaned = " ".join(str(name or "").replace("\xa0", " ").split()).lower()
    if not cleaned or cleaned in NON_ENTITY_TERMS:
        return True
    if any(marker in cleaned for marker in DOMAIN_OUTLET_MARKERS):
        return True
    if any(_word_bounded(marker, cleaned) for marker in DISTINCT_OUTLET_MARKERS):
        return True
    for marker in AMBIGUOUS_OUTLET_MARKERS:
        if _word_bounded(marker, cleaned):
            residue = set(cleaned.split()) - set(marker.split())
            if residue <= _OUTLET_QUALIFIERS:
                return True
    return False


def organization_candidates(names: Iterable[Any]) -> list:
    """Reduces NER organization names to (name, entity_type) pairs worth persisting.

    Lives here (not in the Celery task that uses it) so it can be tested
    without celery/SQLAlchemy installed. Without this guard the Celery
    path resolved "Reuters" or "Punch" into the entity directory every 30
    minutes -- run_pipeline applies the same publication check before
    writing companies. The company-vs-agency guess mirrors the heuristic
    previously inlined in tasks.py.
    """
    out = []
    for name in names or []:
        if is_publication_or_furniture(name):
            continue
        ent_type = "agency" if any(
            kw in str(name).lower() for kw in ["commission", "department", "ministry", "federal"]
        ) else "company"
        out.append((name, ent_type))
    return out
