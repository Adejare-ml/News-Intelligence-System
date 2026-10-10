"""News-center verticals (Package 30): world now, culture & fashion,
markets, AI pulse.

Generalizes the tech_news pattern: keyless sources only (Google News
RSS, CoinGecko, the Hugging Face public API), each
export best-effort per section -- a dead source shrinks its section
rather than failing the run. Everything here stays outside the main
pipeline: no LLM cascade, no Sheets writes, no mixing with the Nigerian
corporate feed. Context for the reader, not intelligence records.

Split for testability like tech_news/fx: pure parsers over fetched
payloads, thin fetchers that own the network.
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

import requests

from backend.app.services.tech_news import (
    REQUEST_TIMEOUT_SECONDS,
    USER_AGENT,
    _fetch_feed,
    _google_rss_url,
    dedupe_items,
)

logger = logging.getLogger(__name__)

MAX_HISTORY_DAYS = 365


def _google_topic_url(topic: str) -> str:
    return ("https://news.google.com/rss/headlines/section/topic/"
            + topic + "?hl=en-US&gl=US&ceid=US:en")


# ---------------------------------------------------------------------------
# World now + culture & fashion (one export, two sections)
# ---------------------------------------------------------------------------

WORLD_SECTIONS: Dict[str, List[str]] = {
    "world": [
        _google_topic_url("WORLD"),
        "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",  # front page
    ],
    "culture": [
        _google_rss_url("\"fashion trends\" OR \"fashion week\" when:7d"),
        _google_topic_url("ENTERTAINMENT"),
    ],
}


def build_world_now(cap: int = 10) -> Dict[str, Any]:
    """world_now.json: {generated, world: [...], culture: [...]}."""
    payload: Dict[str, Any] = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    for section, urls in WORLD_SECTIONS.items():
        merged: List[Dict[str, Any]] = []
        for url in urls:
            merged.extend(_fetch_feed(url, "Google News"))
        payload[section] = dedupe_items(merged, cap)
    return payload


# ---------------------------------------------------------------------------
# Markets (indices, commodities, bitcoin) with daily history like fx.json
# ---------------------------------------------------------------------------

# Indices and commodities came from Stooq's keyless quote CSV until it
# stopped existing: in 2026 Stooq put data downloads behind API keys and
# a JavaScript browser check, and the endpoint answered every production
# run with HTTP 404 (percent-encoded carets included -- see the
# 2026-10-10 audit). There is no keyless replacement for index and
# commodity quotes, and this project's verticals are keyless by design,
# so the markets export is BTC-only for now. Old spx/ndx/brent/gold
# points remain in markets.json history with their honest dates. To
# revive the section, add a keyed provider (e.g. Tiingo or Alpha
# Vantage, both have free tiers) behind a secret and fold its closes
# into fetch_market_rates() -- merge_market_history and the dashboard
# panel need no changes, they render whatever keys arrive.
COINGECKO_URL = ("https://api.coingecko.com/api/v3/simple/price"
                 "?ids=bitcoin&vs_currencies=usd")


def parse_btc(payload: Optional[Dict[str, Any]]) -> Optional[float]:
    try:
        value = float(payload["bitcoin"]["usd"])
        return round(value, 2) if value > 0 else None
    except (TypeError, KeyError, ValueError):
        return None


def fetch_market_rates() -> Dict[str, float]:
    """Live quotes; whatever sections fail are simply absent."""
    rates: Dict[str, float] = {}
    try:
        resp = requests.get(COINGECKO_URL, timeout=REQUEST_TIMEOUT_SECONDS,
                            headers=USER_AGENT)
        if resp.status_code == 200:
            btc = parse_btc(resp.json())
            if btc:
                rates["btc"] = btc
        else:
            logger.warning(f"CoinGecko returned HTTP {resp.status_code}.")
    except Exception as exc:
        logger.warning(f"CoinGecko fetch failed: {type(exc).__name__}")
    return rates


def merge_market_history(existing: Optional[Dict[str, Any]],
                         rates: Dict[str, float],
                         now: datetime) -> Optional[Dict[str, Any]]:
    """Fold today's quotes into markets.json. Same contract as fx:
    one point per day (latest run wins), 365-day cap, and empty rates
    -> None so the caller keeps the previous file untouched. Unlike fx,
    a PARTIAL day is kept: the five sources are independent markets and
    one being closed must not discard the others."""
    if not rates:
        return None
    today = now.strftime("%Y-%m-%d")
    history: List[Dict[str, Any]] = []
    for point in (existing or {}).get("history") or []:
        date = str((point or {}).get("date", ""))[:10]
        if date and date != today:
            history.append(point)
    point: Dict[str, Any] = {"date": today}
    point.update(rates)
    history.append(point)
    history.sort(key=lambda p: p.get("date", ""))
    history = history[-MAX_HISTORY_DAYS:]
    return {
        "generated": now.strftime("%Y-%m-%d %H:%M:%S"),
        "sources": "coingecko.com (BTC)",
        "unit": "USD",
        "latest": dict(rates),
        "history": history,
    }


# ---------------------------------------------------------------------------
# AI pulse: Hugging Face trending models + daily papers
# ---------------------------------------------------------------------------

HF_MODELS_URL = ("https://huggingface.co/api/models"
                 "?sort=trendingScore&direction=-1&limit=8")
HF_PAPERS_URL = "https://huggingface.co/api/daily_papers?limit=6"


def parse_hf_models(payload: Any) -> List[Dict[str, Any]]:
    """HF /api/models rows -> {id, url, task, likes, downloads}."""
    out = []
    for row in payload if isinstance(payload, list) else []:
        if not isinstance(row, dict):
            continue
        model_id = str(row.get("id") or "").strip()
        if not model_id:
            continue
        out.append({
            "id": model_id,
            "url": "https://huggingface.co/" + model_id,
            "task": str(row.get("pipeline_tag") or "").strip(),
            "likes": int(row.get("likes") or 0),
            "downloads": int(row.get("downloads") or 0),
        })
    return out


def parse_hf_papers(payload: Any) -> List[Dict[str, Any]]:
    """HF /api/daily_papers rows -> {title, url, upvotes}."""
    out = []
    for row in payload if isinstance(payload, list) else []:
        if not isinstance(row, dict):
            continue
        paper = row.get("paper")
        if not isinstance(paper, dict):
            continue
        title = str(paper.get("title") or "").strip()
        paper_id = str(paper.get("id") or "").strip()
        if not title or not paper_id:
            continue
        out.append({
            "title": " ".join(title.split()),
            "url": "https://huggingface.co/papers/" + paper_id,
            "upvotes": int(paper.get("upvotes") or 0),
        })
    return out


def _fetch_json(url: str, label: str) -> Any:
    try:
        resp = requests.get(url, timeout=REQUEST_TIMEOUT_SECONDS,
                            headers=USER_AGENT)
        if resp.status_code == 200:
            return resp.json()
        logger.warning(f"{label} returned HTTP {resp.status_code}.")
    except Exception as exc:
        logger.warning(f"{label} fetch failed: {type(exc).__name__}")
    return None


def build_ai_pulse() -> Dict[str, Any]:
    """ai_pulse.json: {generated, models: [...], papers: [...]}."""
    return {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "models": parse_hf_models(_fetch_json(HF_MODELS_URL, "HF models")),
        "papers": parse_hf_papers(_fetch_json(HF_PAPERS_URL, "HF papers")),
    }
