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

import logging
from datetime import datetime
from typing import Any, Dict, List

import requests  # noqa: F401  (kept: tests patch tech_news.requests)

from backend.app.services.headlines import (  # noqa: F401  (re-exported)
    REQUEST_TIMEOUT_SECONDS,
    SECTION_CAP,
    USER_AGENT,
    dedupe_items,
    fetch_feed as _fetch_feed,
    google_search_url,
    merged_section,
    parse_feed_entries,
)

logger = logging.getLogger(__name__)


def _google_rss_url(query: str) -> str:
    return google_search_url(query, "global")


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


def build_tech_news() -> Dict[str, Any]:
    """The tech_news.json payload: {generated, ai: [...], dev: [...]}."""
    payload: Dict[str, Any] = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    for section, urls in SECTIONS.items():
        payload[section] = merged_section(urls, fetch=_fetch_feed)
    return payload
