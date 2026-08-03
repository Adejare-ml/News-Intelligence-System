"""Bake Natural Earth coastlines into a static asset for the dashboard globe.

The dashboard is served from GitHub Pages under a strict CSP whose image policy
is ``img-src 'self' data:``. That rules out pulling an Earth texture from a tile
server or a CDN at runtime, and the site has no build step that could fetch one.

So the land mask is rasterised **here**, at author time, and committed as a
plain JS file. The browser then renders the globe procedurally from a bit array
with no network request and no third-party dependency.

Run manually when the coastline resolution needs to change::

    python tools/build_globe_data.py

Output: ``backend/app/static/js/globe-data.js``
"""

from __future__ import annotations

import base64
import json
import logging
import urllib.request
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image, ImageDraw

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

NE_BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"
LAND_URL = f"{NE_BASE}/ne_110m_land.geojson"
COUNTRIES_URL = f"{NE_BASE}/ne_110m_admin_0_countries.geojson"

# 1 degree per cell. A dot globe samples every 2-3 degrees, so this is already
# finer than the render needs, and it keeps the payload near 11 KB of base64.
GRID_W, GRID_H = 360, 180

OUT_PATH = Path(__file__).resolve().parents[1] / "backend/app/static/js/globe-data.js"

# Highlighted on the globe because the pipeline tracks Nigerian corporate
# ownership; the outline is what anchors the viewer geographically.
FOCUS_COUNTRY = "Nigeria"


def fetch_geojson(url: str) -> dict[str, Any]:
    logger.info("fetching %s", url)
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def iter_rings(geometry: dict[str, Any]) -> Iterable[list[list[float]]]:
    """Yield every exterior/interior ring of a (Multi)Polygon geometry."""
    kind = geometry.get("type")
    coords = geometry.get("coordinates", [])
    if kind == "Polygon":
        yield from coords
    elif kind == "MultiPolygon":
        for polygon in coords:
            yield from polygon


def lonlat_to_pixel(lon: float, lat: float) -> tuple[float, float]:
    """Equirectangular projection onto the raster grid."""
    x = (lon + 180.0) / 360.0 * GRID_W
    y = (90.0 - lat) / 180.0 * GRID_H
    return x, y


def rasterise_land(land: dict[str, Any]) -> np.ndarray:
    """Burn land polygons into a boolean grid, True where there is land."""
    canvas = Image.new("1", (GRID_W, GRID_H), 0)
    painter = ImageDraw.Draw(canvas)

    for feature in land.get("features", []):
        for ring in iter_rings(feature.get("geometry", {})):
            points = [lonlat_to_pixel(lon, lat) for lon, lat, *_ in ring]
            if len(points) >= 3:
                painter.polygon(points, fill=1)

    grid = np.array(canvas, dtype=bool)
    logger.info(
        "rasterised %dx%d grid, %.1f%% land",
        GRID_W,
        GRID_H,
        100.0 * grid.mean(),
    )
    return grid


def pack_mask(grid: np.ndarray) -> str:
    """Pack the boolean grid MSB-first into base64."""
    packed = np.packbits(grid.flatten())
    return base64.b64encode(packed.tobytes()).decode("ascii")


def extract_outline(countries: dict[str, Any], name: str) -> list[list[float]]:
    """Return the largest ring of a country as flat [lon, lat] pairs.

    Only the biggest ring is kept: the globe draws a single recognisable
    silhouette, not an exact cartographic boundary, so offshore islands and
    interior holes are noise at this scale.
    """
    best: list[list[float]] = []
    for feature in countries.get("features", []):
        properties = feature.get("properties", {})
        candidates = {
            str(properties.get(key, "")).strip()
            for key in ("NAME", "NAME_EN", "ADMIN", "SOVEREIGNT")
        }
        if name not in candidates:
            continue
        for ring in iter_rings(feature.get("geometry", {})):
            if len(ring) > len(best):
                best = ring

    if not best:
        raise ValueError(f"country {name!r} not found in the countries dataset")

    outline = [[round(float(lon), 3), round(float(lat), 3)] for lon, lat, *_ in best]
    logger.info("extracted %s outline with %d points", name, len(outline))
    return outline


def render_module(mask_b64: str, outline: list[list[float]]) -> str:
    """Emit the JS module. Deliberately dependency-free and human-readable."""
    outline_json = json.dumps(outline, separators=(",", ":"))
    return f"""// GENERATED FILE -- do not edit by hand.
// Regenerate with: python tools/build_globe_data.py
//
// Coastlines are baked in at author time because the dashboard's CSP allows
// images only from 'self' and data: URIs, so a runtime Earth texture is not an
// option. Source: Natural Earth 110m (public domain).
window.AURA_GLOBE_DATA = {{
    // {GRID_W}x{GRID_H} equirectangular land mask, 1 bit per cell, MSB first,
    // row-major from lat +90 down to -90 and lon -180 to +180.
    maskWidth: {GRID_W},
    maskHeight: {GRID_H},
    mask: "{mask_b64}",
    // Largest ring of the focus country, as [lon, lat] pairs.
    focusName: {json.dumps(FOCUS_COUNTRY)},
    focusOutline: {outline_json}
}};
"""


def main() -> None:
    land = fetch_geojson(LAND_URL)
    countries = fetch_geojson(COUNTRIES_URL)

    grid = rasterise_land(land)
    mask_b64 = pack_mask(grid)
    outline = extract_outline(countries, FOCUS_COUNTRY)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(render_module(mask_b64, outline), encoding="utf-8")
    logger.info("wrote %s (%.1f KB)", OUT_PATH, OUT_PATH.stat().st_size / 1024)


if __name__ == "__main__":
    main()
