"""Reader-chosen news categories for the Morning Brief.

Business is AURA's own brief (the ownership/corporate pipeline). The
other categories a reader can tick at sign-up -- technology and
politics -- are headline sections built here from keyless Google News
feeds, each in two editions: Nigeria and Global. (Sports and
entertainment were offered once and have been cut.)

Like the other verticals this stays outside the main pipeline: no LLM
cascade, no Sheets writes. The export is ``category_news.json``:

    {
      "generated": "2026-11-06 07:05:12",
      "regions": ["nigeria", "global"],
      "sections": {
        "technology": {"nigeria": [item, ...], "global": [item, ...]},
        ...
      }
    }

Each item is ``{title, url, source, published}`` (see headlines.py).
"""

from datetime import datetime
from typing import Any, Callable, Dict, List

from backend.app.services.headlines import (
    REGIONS,
    fetch_feed,
    google_search_url,
    google_topic_url,
    merged_section,
)

CATEGORY_CAP = 8

# Order is the order sections appear in emails and on the site.
CATEGORY_LABELS: Dict[str, str] = {
    "technology": "Technology",
    "politics": "Politics",
}
CATEGORIES = tuple(CATEGORY_LABELS)

# Each region lists its feeds best-first: the dedupe keeps the first copy
# of a story, and the cap keeps the section short.
CATEGORY_FEEDS: Dict[str, Dict[str, List[str]]] = {
    "technology": {
        "nigeria": [
            google_search_url("Nigeria (tech OR startup OR fintech OR telecom) when:2d", "nigeria"),
            google_topic_url("TECHNOLOGY", "nigeria"),
        ],
        "global": [google_topic_url("TECHNOLOGY", "global")],
    },
    "politics": {
        "nigeria": [
            google_search_url("Nigeria (politics OR Tinubu OR INEC OR Senate OR governor) when:1d", "nigeria"),
        ],
        "global": [
            google_search_url("(election OR parliament OR president OR \"prime minister\") politics when:1d", "global"),
            google_topic_url("WORLD", "global"),
        ],
    },
}


def build_category_news(cap: int = CATEGORY_CAP,
                        fetch: Callable[[str, str], List[Dict[str, Any]]] = None,
                        now: datetime = None) -> Dict[str, Any]:
    """The category_news.json payload. ``fetch`` defaults to the live
    network fetcher; tests pass a fake."""
    fetch = fetch or fetch_feed
    sections: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    for category in CATEGORIES:
        sections[category] = {
            region: merged_section(CATEGORY_FEEDS[category][region], fetch=fetch, cap=cap)
            for region in REGIONS
        }
    return {
        "generated": (now or datetime.now()).strftime("%Y-%m-%d %H:%M:%S"),
        "regions": list(REGIONS),
        "labels": dict(CATEGORY_LABELS),
        "sections": sections,
    }


def has_headlines(payload: Dict[str, Any]) -> bool:
    """True when at least one category/region produced something -- the
    caller keeps the previous file rather than publishing an empty one."""
    for regions in (payload or {}).get("sections", {}).values():
        for items in (regions or {}).values():
            if items:
                return True
    return False
