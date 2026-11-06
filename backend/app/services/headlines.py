"""Shared keyless headline feeds.

Every headline vertical (tech & AI, world & culture, the reader-chosen
news categories) is built the same way: fetch a few public RSS feeds,
turn entries into plain ``{title, url, source, published}`` items, merge,
dedupe and cap. This module holds that machinery so each vertical only
declares *which* feeds it wants.

Sources are keyless by design so the verticals work on any fork with no
secrets. Everything is best-effort per feed: a dead source shrinks its
section rather than failing the run.
"""

import html
import logging
from typing import Any, Dict, Iterable, List

import feedparser
import requests

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT_SECONDS = 15
SECTION_CAP = 12

USER_AGENT = {"User-Agent": "AURA-NewsIntel/1.0"}

# Google News edition parameters per reader region. "nigeria" is the
# Nigerian English edition; "global" is the international English one
# the existing verticals always used.
REGION_PARAMS: Dict[str, str] = {
    "nigeria": "hl=en-NG&gl=NG&ceid=NG:en",
    "global": "hl=en-US&gl=US&ceid=US:en",
}
REGIONS = tuple(REGION_PARAMS)


def _region_params(region: str) -> str:
    try:
        return REGION_PARAMS[region]
    except KeyError:
        raise ValueError(f"Unknown region: {region!r}") from None


def google_search_url(query: str, region: str = "global") -> str:
    """A Google News search feed for ``query`` in the given region's edition."""
    return ("https://news.google.com/rss/search?q="
            + requests.utils.quote(query) + "&" + _region_params(region))


def google_topic_url(topic: str, region: str = "global") -> str:
    """A Google News topic feed (WORLD, SPORTS, TECHNOLOGY, ...)."""
    return ("https://news.google.com/rss/headlines/section/topic/"
            + topic + "?" + _region_params(region))


def parse_feed_entries(entries: Iterable[Any], fallback_source: str) -> List[Dict[str, Any]]:
    """Feed entries -> plain headline items. Tolerates missing fields;
    entries without a title or an http(s) link are dropped rather than
    rendered as blanks."""
    items = []
    for entry in entries or []:
        title = html.unescape(str(entry.get("title") or "")).strip()
        url = str(entry.get("link") or "").strip()
        if not title or not url.startswith(("http://", "https://")):
            continue
        source = ""
        src = entry.get("source")
        if src:
            source = str(src.get("title") or "").strip()
        items.append({
            "title": title,
            "url": url,
            "source": source or fallback_source,
            # Verbatim; unparseable dates render as-is rather than invented.
            "published": str(entry.get("published") or ""),
        })
    return items


def dedupe_items(items: Iterable[Dict[str, Any]], cap: int = SECTION_CAP) -> List[Dict[str, Any]]:
    """First occurrence wins, keyed on URL and case-folded title -- Google
    News surfaces the same story under several outlet URLs, and HN posts
    sometimes duplicate a Google hit by title."""
    seen_urls = set()
    seen_titles = set()
    out = []
    for item in items or []:
        url = item.get("url", "")
        title_key = str(item.get("title", "")).casefold()
        if url in seen_urls or title_key in seen_titles:
            continue
        seen_urls.add(url)
        seen_titles.add(title_key)
        out.append(item)
        if len(out) >= cap:
            break
    return out


def fetch_feed(url: str, fallback_source: str) -> List[Dict[str, Any]]:
    """One feed, best-effort. Explicit timeout: feedparser's own URL
    fetching has none (same reasoning as the main RSS adapter)."""
    try:
        resp = requests.get(url, timeout=REQUEST_TIMEOUT_SECONDS, headers=USER_AGENT)
        resp.raise_for_status()
        return parse_feed_entries(feedparser.parse(resp.content).entries, fallback_source)
    except Exception as exc:
        # Exception class only -- a ConnectionError message embeds the URL.
        logger.warning("Headline feed failed (%s): %s", fallback_source, type(exc).__name__)
        return []


def fallback_source_for(url: str) -> str:
    return "Hacker News" if "hnrss" in url else "Google News"


def merged_section(urls: Iterable[str], fetch=fetch_feed, cap: int = SECTION_CAP) -> List[Dict[str, Any]]:
    """Fetch each URL, merge in order, dedupe and cap. ``fetch`` is
    injectable so callers (and their tests) can swap the network out."""
    merged: List[Dict[str, Any]] = []
    for url in urls:
        merged.extend(fetch(url, fallback_source_for(url)))
    return dedupe_items(merged, cap)
