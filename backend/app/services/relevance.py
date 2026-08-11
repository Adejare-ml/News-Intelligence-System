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

NEWS_OUTLET_MARKERS = (
    "guardian", "premium times", "punch", "vanguard", "daily post", "dailypost",
    "thisday", "this day", "nairametrics", "channels tv", "channels television",
    "leadership newspaper", "the nation", "businessday", "business day", "tribune",
    "sahara reporters", "peoples gazette", "the cable", "thecable", "legit.ng",
    "reuters", "bloomberg", "associated press", "al jazeera", "bbc", "cnn",
)

# Navigation furniture scraped from article pages.
NON_ENTITY_TERMS = {
    "archives", "archive", "home", "newsletter", "advertisement", "sponsored",
    "read more", "subscribe", "latest news", "breaking news", "news",
}


def is_publication_or_furniture(name: Any) -> bool:
    """True when an extracted organization is really the publication or page chrome."""
    cleaned = " ".join(str(name or "").replace("\xa0", " ").split()).lower()
    if not cleaned or cleaned in NON_ENTITY_TERMS:
        return True
    return any(marker in cleaned for marker in NEWS_OUTLET_MARKERS)
