"""Tech & AI news vertical (Package 14).

A separate, keyless headline feed for the AI industry and the developer
world, exported as ``static/data/tech_news.json`` and rendered in its
own dashboard panel. Deliberately outside the main pipeline: these
headlines never touch the LLM cascade (zero provider quota), never enter
the Sheets database, and never mix with the Nigerian corporate feed --
they are context for the reader, not intelligence records.

Sources are keyless by design so the vertical works on any fork with no
secrets: Google News RSS queries (the same endpoint the main pipeline
already uses) and the Hacker News front page via hnrss.org. Everything
is best-effort per feed -- a dead source shrinks the section rather than
failing the run.
"""

import html
import logging
from datetime import datetime
from typing import Any, Dict, List

import feedparser
import requests

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT_SECONDS = 15
SECTION_CAP = 12

USER_AGENT = {"User-Agent": "AURA-NewsIntel/1.0"}


def _google_rss_url(query: str) -> str:
    return ("https://news.google.com/rss/search?q="
            + requests.utils.quote(query) + "&hl=en-US&gl=US&ceid=US:en")


# Two sections, each a list of RSS URLs merged then deduped and capped.
SECTIONS: Dict[str, List[str]] = {
    "ai": [
        _google_rss_url("artificial intelligence when:2d"),
        _google_rss_url("OpenAI OR Anthropic OR DeepMind OR \"large language model\" when:2d"),
    ],
    "dev": [
        "https://hnrss.org/frontpage",
        _google_rss_url("\"developer tools\" OR \"open source\" software when:2d"),
    ],
}


def parse_feed_entries(entries: List[Any], fallback_source: str) -> List[Dict[str, Any]]:
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


def dedupe_items(items: List[Dict[str, Any]], cap: int = SECTION_CAP) -> List[Dict[str, Any]]:
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


def _fetch_feed(url: str, fallback_source: str) -> List[Dict[str, Any]]:
    """One feed, best-effort. Explicit timeout: feedparser's own URL
    fetching has none (same reasoning as the main RSS adapter)."""
    try:
        resp = requests.get(url, timeout=REQUEST_TIMEOUT_SECONDS, headers=USER_AGENT)
        resp.raise_for_status()
        return parse_feed_entries(feedparser.parse(resp.content).entries, fallback_source)
    except Exception as exc:
        # Exception class only -- a ConnectionError message embeds the URL.
        logger.warning("Tech news feed failed (%s): %s", fallback_source, type(exc).__name__)
        return []


def build_tech_news() -> Dict[str, Any]:
    """The tech_news.json payload: {generated, ai: [...], dev: [...]}."""
    payload: Dict[str, Any] = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    for section, urls in SECTIONS.items():
        merged: List[Dict[str, Any]] = []
        for url in urls:
            fallback = "Hacker News" if "hnrss" in url else "Google News"
            merged.extend(_fetch_feed(url, fallback))
        payload[section] = dedupe_items(merged)
    return payload
