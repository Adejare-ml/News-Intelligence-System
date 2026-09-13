"""
Weather context for the dashboard, fetched pipeline-side.

The shipped site's CSP pins connect-src to 'self', so the browser cannot
call a weather API directly; the pipeline fetches during its scheduled
runs and publishes data/weather.json like every other dataset. Open-Meteo
is keyless and CC-licensed, which keeps the workflow secret-free.

Best-effort by design: a weather outage must never touch the news run.
The fetch returns None on any failure and the caller keeps the previous
file on disk rather than publishing an empty one.
"""
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

# The two home ports the globe already anchors on.
DEFAULT_CITIES = (
    {"name": "Lagos", "lat": 6.52, "lon": 3.38},
    {"name": "Abuja", "lat": 9.06, "lon": 7.49},
)

# WMO weather interpretation codes (Open-Meteo's `weather_code`), reduced
# to the buckets that occur in West Africa often enough to matter.
_WMO_DESCRIPTIONS = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Heavy drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    80: "Rain showers",
    81: "Rain showers",
    82: "Violent rain showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Thunderstorm with hail",
}


def describe_weather_code(code: Any) -> str:
    """Human phrase for a WMO weather code; unknown codes stay honest."""
    try:
        return _WMO_DESCRIPTIONS.get(int(code), "Unknown conditions")
    except (TypeError, ValueError):
        return "Unknown conditions"


def build_weather_payload(city_results: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Reduce raw Open-Meteo `current` blocks to the fields the widget shows.

    Pure, so the shape is testable without the network. Returns None when
    no city produced usable numbers -- the caller then keeps the previous
    weather.json instead of overwriting it with nothing.
    """
    cities = []
    for entry in city_results or []:
        current = (entry.get("data") or {}).get("current") or {}
        temp = current.get("temperature_2m")
        if temp is None:
            continue
        cities.append({
            "name": entry.get("name", ""),
            "temp_c": round(float(temp), 1),
            "humidity": current.get("relative_humidity_2m"),
            "wind_kmh": current.get("wind_speed_10m"),
            "code": current.get("weather_code"),
            "description": describe_weather_code(current.get("weather_code")),
        })
    if not cities:
        return None
    return {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": "open-meteo.com",
        "cities": cities,
    }


def fetch_weather(cities=DEFAULT_CITIES, timeout: float = 10.0) -> Optional[Dict[str, Any]]:
    """Fetch current conditions for the configured cities. None on failure."""
    results = []
    for city in cities:
        try:
            r = requests.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": city["lat"],
                    "longitude": city["lon"],
                    "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
                    "timezone": "Africa/Lagos",
                },
                timeout=timeout,
            )
            if r.status_code == 200:
                results.append({"name": city["name"], "data": r.json()})
            else:
                logger.warning("Open-Meteo returned HTTP %s for %s", r.status_code, city["name"])
        except Exception as exc:
            logger.warning("Weather fetch failed for %s (%s)", city["name"], type(exc).__name__)
    return build_weather_payload(results)
