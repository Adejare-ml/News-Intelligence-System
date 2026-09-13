"""
Trend tracking: what is rising and falling across the pipeline's own
articles, plus an optional external social signal.

The momentum computation is deliberately built on data this system
already extracts -- term counts over the published Articles rows -- so
the "Trending" panel never asserts a trend the underlying records cannot
substantiate. The one external signal (r/Nigeria via Reddit's public
JSON) is fetched best-effort, clearly attributed, and its absence leaves
the panel intact.
"""
import logging
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import requests

from backend.app.services.ingestion import parse_feed_date

logger = logging.getLogger(__name__)

# Words that carry no trend signal in Nigerian corporate headlines: glue
# words, plus the boilerplate this corpus repeats in almost every title.
_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
    "has", "have", "he", "her", "his", "how", "in", "into", "is", "it",
    "its", "may", "more", "new", "no", "not", "of", "on", "or", "our",
    "over", "say", "says", "she", "so", "than", "that", "the", "their",
    "this", "to", "up", "was", "we", "were", "who", "why", "will", "with",
    "you", "after", "amid", "against", "among", "before", "between",
    "during", "under", "within", "about", "out", "off", "n", "bn", "m",
    "nigeria", "nigerian", "nigerians", "news", "fg", "govt", "government",
    "state", "states", "year", "years", "day", "days", "week", "billion",
    "million", "naira", "percent", "per", "cent", "ceo", "boss", "chief",
}

_TOKEN_RE = re.compile(r"[a-z][a-z'’-]{2,}")


def _terms(title: Any) -> set:
    """Distinct meaningful unigrams + adjacent bigrams from one title.

    A set, so one headline counts a term once however often it repeats it;
    trend counts then mean "articles mentioning X", not "times X was typed".
    """
    words = _TOKEN_RE.findall(str(title or "").lower())
    kept = [w for w in words if w not in _STOPWORDS]
    terms = set(kept)
    for i in range(len(words) - 1):
        if words[i] not in _STOPWORDS and words[i + 1] not in _STOPWORDS:
            terms.add(f"{words[i]} {words[i + 1]}")
    return terms


def compute_trends(article_rows: List[Dict[str, Any]], now: datetime = None,
                   window_days: int = 7, top_n: int = 10) -> Dict[str, Any]:
    """Term and category momentum: the last `window_days` vs the window before.

    Pure and deterministic for a given `now`. Rows without a readable Time,
    and rows the pipeline filtered ("Filtered" status), are excluded --
    a trend built on rejected articles would be a trend in the junk, not
    the news.
    """
    now = now or datetime.now()
    recent_start = now - timedelta(days=window_days)
    previous_start = now - timedelta(days=2 * window_days)

    recent_terms: Dict[str, int] = {}
    previous_terms: Dict[str, int] = {}
    recent_categories: Dict[str, int] = {}
    previous_categories: Dict[str, int] = {}
    recent_articles = 0
    previous_articles = 0

    for row in article_rows or []:
        if str(row.get("Status", "")).strip().lower() == "filtered":
            continue
        stamp = parse_feed_date(row.get("Time"))
        if stamp is None or stamp < previous_start or stamp > now:
            continue
        recent = stamp >= recent_start
        terms_bucket = recent_terms if recent else previous_terms
        cats_bucket = recent_categories if recent else previous_categories
        if recent:
            recent_articles += 1
        else:
            previous_articles += 1
        for term in _terms(row.get("Title")):
            terms_bucket[term] = terms_bucket.get(term, 0) + 1
        category = str(row.get("Category", "")).strip()
        if category:
            cats_bucket[category] = cats_bucket.get(category, 0) + 1

    def movement(minimum_recent: int):
        moves = []
        for term in set(recent_terms) | set(previous_terms):
            recent_n = recent_terms.get(term, 0)
            previous_n = previous_terms.get(term, 0)
            moves.append({"term": term, "recent": recent_n,
                          "previous": previous_n, "change": recent_n - previous_n})
        rising = sorted(
            [m for m in moves if m["change"] > 0 and m["recent"] >= minimum_recent],
            key=lambda m: (-m["change"], -m["recent"], m["term"]))[:top_n]
        falling = sorted(
            [m for m in moves if m["change"] < 0 and m["previous"] >= minimum_recent],
            key=lambda m: (m["change"], -m["previous"], m["term"]))[:top_n]
        return rising, falling

    # Two mentions minimum: a single article is a story, not a trend.
    rising, falling = movement(minimum_recent=2)

    categories = sorted(
        [{"category": c,
          "recent": recent_categories.get(c, 0),
          "previous": previous_categories.get(c, 0)}
         for c in set(recent_categories) | set(previous_categories)],
        key=lambda e: (-e["recent"], e["category"]))

    return {
        "window_days": window_days,
        "recent_articles": recent_articles,
        "previous_articles": previous_articles,
        "rising": rising,
        "falling": falling,
        "categories": categories,
    }


def fetch_reddit_nigeria(limit: int = 12, timeout: float = 10.0) -> List[Dict[str, Any]]:
    """Top r/Nigeria hot posts via the public JSON endpoint. Best-effort.

    Keyless but User-Agent-gated; failures return [] and the panel simply
    omits the social column. Only canonical reddit permalinks are kept, so
    a post cannot smuggle an arbitrary URL into the page.
    """
    try:
        r = requests.get(
            "https://www.reddit.com/r/Nigeria/hot.json",
            params={"limit": limit},
            headers={"User-Agent": "aura-news-intelligence/1.0 (context panel)"},
            timeout=timeout,
        )
        if r.status_code != 200:
            logger.warning("Reddit returned HTTP %s; social signal omitted this cycle.", r.status_code)
            return []
        posts = []
        for child in (r.json().get("data") or {}).get("children") or []:
            data = child.get("data") or {}
            permalink = str(data.get("permalink") or "")
            if not permalink.startswith("/r/"):
                continue
            if data.get("stickied"):
                continue
            posts.append({
                "title": str(data.get("title") or "")[:200],
                "score": int(data.get("score") or 0),
                "comments": int(data.get("num_comments") or 0),
                "url": f"https://www.reddit.com{permalink}",
            })
        return posts
    except Exception as exc:
        logger.warning("Reddit fetch failed (%s); social signal omitted this cycle.", type(exc).__name__)
        return []
