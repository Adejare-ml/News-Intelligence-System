"""Side feeds exported next to the intelligence data on every run.

Weather, Naira FX, markets, world & culture headlines, the AI pulse, tech
headlines and the reader-chosen news categories. All are keyless, all
outside the LLM pipeline, and all best-effort: a dead source never fails
a news run, and an empty result keeps the previous file (with its honest
date) rather than publishing a blank one.

They are fetched pipeline-side because the site's CSP pins connect-src to
'self'.
"""

import json
import logging
import os
from datetime import datetime
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("run_pipeline")


def _write_json(data_dir: str, name: str, payload: Any) -> None:
    with open(os.path.join(data_dir, name), "w", encoding="utf-8") as f:
        json.dump(payload, f, default=str, indent=2)


def _read_json(data_dir: str, name: str) -> Optional[Dict[str, Any]]:
    path = os.path.join(data_dir, name)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def export_weather(data_dir: str) -> None:
    from backend.app.services.weather import fetch_weather
    weather = fetch_weather()
    if weather:
        _write_json(data_dir, "weather.json", weather)


def export_fx(data_dir: str) -> None:
    """One history point per day, the day's latest run winning."""
    from backend.app.services.fx import fetch_rates, merge_history
    fx = merge_history(_read_json(data_dir, "fx.json"), fetch_rates(), datetime.now())
    if fx:
        _write_json(data_dir, "fx.json", fx)


def export_world_now(data_dir: str) -> None:
    from backend.app.services.verticals import build_world_now
    world = build_world_now()
    if world.get("world") or world.get("culture"):
        _write_json(data_dir, "world_now.json", world)


def export_markets(data_dir: str) -> None:
    from backend.app.services.verticals import fetch_market_rates, merge_market_history
    markets = merge_market_history(_read_json(data_dir, "markets.json"),
                                   fetch_market_rates(), datetime.now())
    if markets:
        _write_json(data_dir, "markets.json", markets)


def export_ai_pulse(data_dir: str) -> None:
    from backend.app.services.verticals import build_ai_pulse
    pulse = build_ai_pulse()
    if pulse.get("models") or pulse.get("papers"):
        _write_json(data_dir, "ai_pulse.json", pulse)


def export_tech_news(data_dir: str) -> None:
    from backend.app.services.tech_news import build_tech_news
    tech = build_tech_news()
    if tech.get("ai") or tech.get("dev"):
        _write_json(data_dir, "tech_news.json", tech)
    else:
        logger.warning("Tech news export skipped: every feed came back empty.")


def export_category_news(data_dir: str) -> None:
    """Sports, technology, politics and entertainment headlines, Nigeria
    and Global, for the site's category pages and the Morning Brief."""
    from backend.app.services.categories import build_category_news, has_headlines
    news = build_category_news()
    if has_headlines(news):
        _write_json(data_dir, "category_news.json", news)
    else:
        logger.warning("Category news export skipped: every feed came back empty.")


SIDE_FEEDS: Dict[str, Callable[[str], None]] = {
    "Weather": export_weather,
    "FX": export_fx,
    "World-now": export_world_now,
    "Markets": export_markets,
    "AI-pulse": export_ai_pulse,
    "Tech news": export_tech_news,
    "Category news": export_category_news,
}


def export_side_feeds(data_dir: str, feeds: Dict[str, Callable[[str], None]] = None) -> None:
    """Run every side feed; one failing never stops the others."""
    for label, export in (feeds or SIDE_FEEDS).items():
        try:
            export(data_dir)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(f"{label} export skipped: {exc}")
