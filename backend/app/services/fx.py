"""Daily naira exchange-rate snapshot (USD/EUR/GBP -> NGN).

Source: open.er-api.com's free endpoint -- no key, generous limits, and
the pipeline only asks four times a day. The fetch is best-effort like
every other side channel: any failure leaves the previous fx.json
untouched, so the dashboard and the morning email keep showing the last
good snapshot with its honest date rather than nothing.

History contract: one point per calendar day, the day's latest run wins,
capped at 365 days. Rates are naira per unit of foreign currency.
"""
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

FX_ENDPOINT = "https://open.er-api.com/v6/latest/USD"
FX_TIMEOUT_SECONDS = 15
CURRENCIES = ("USD", "EUR", "GBP")
MAX_HISTORY_DAYS = 365


def naira_rates(payload: Optional[Dict[str, Any]]) -> Optional[Dict[str, float]]:
    """{'USD': naira_per_usd, 'EUR': ..., 'GBP': ...} from the API payload.

    The endpoint quotes everything per USD, so cross rates derive as
    NGN/EUR = rates.NGN / rates.EUR. Returns None unless every rate is
    present, numeric and positive -- a partial snapshot is worse than
    keeping yesterday's complete one.
    """
    if not payload or payload.get("result") != "success":
        return None
    rates = payload.get("rates") or {}
    try:
        ngn = float(rates["NGN"])
        out = {}
        for currency in CURRENCIES:
            per_usd = float(rates[currency])
            if per_usd <= 0 or ngn <= 0:
                return None
            out[currency] = round(ngn / per_usd, 2)
        return out
    except (KeyError, TypeError, ValueError):
        return None


def fetch_rates() -> Optional[Dict[str, float]]:
    """Live fetch; None on any failure (logged, never raised)."""
    try:
        response = requests.get(FX_ENDPOINT, timeout=FX_TIMEOUT_SECONDS)
        if response.status_code != 200:
            logger.warning(f"FX endpoint returned HTTP {response.status_code}.")
            return None
        return naira_rates(response.json())
    except Exception as exc:
        logger.warning(f"FX fetch failed: {exc}")
        return None


def merge_history(existing: Optional[Dict[str, Any]],
                  rates: Optional[Dict[str, float]],
                  now: datetime) -> Optional[Dict[str, Any]]:
    """Fold today's rates into the exported fx.json shape.

    None rates -> None (caller keeps the existing file untouched).
    A same-day re-run replaces the day's point instead of duplicating it.
    """
    if not rates:
        return None
    today = now.strftime("%Y-%m-%d")
    history: List[Dict[str, Any]] = []
    for point in (existing or {}).get("history") or []:
        date = str((point or {}).get("date", ""))[:10]
        if date and date != today:
            history.append(point)
    point = {"date": today}
    point.update(rates)
    history.append(point)
    history.sort(key=lambda p: p.get("date", ""))
    history = history[-MAX_HISTORY_DAYS:]
    return {
        "generated": now.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "open.er-api.com",
        "unit": "NGN per 1 unit",
        "latest": dict(rates),
        "history": history,
    }


def day_change_pct(fx: Optional[Dict[str, Any]],
                   currency: str = "USD") -> Optional[float]:
    """Percent move of a currency vs the previous recorded day, or None."""
    history = (fx or {}).get("history") or []
    values = [p.get(currency) for p in history
              if isinstance(p.get(currency), (int, float))]
    if len(values) < 2 or not values[-2]:
        return None
    return round(100 * (values[-1] - values[-2]) / values[-2], 2)
