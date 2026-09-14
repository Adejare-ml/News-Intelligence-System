"""Derived analytics computed at export time (round 5, Package 22).

Every function here is pure aggregation over sheet rows the exporter has
already read into memory -- the Sheets client memoises one read per tab
per process -- so none of these datasets costs additional API quota or
LLM calls. They exist because the accumulated Articles/PSC/Procurement
history holds answers (trajectories, networks, deltas) that no snapshot
export could carry.

Everything degrades gracefully on the data that actually exists: rows
written before the Articles sheet carried an ``Entities`` column simply
contribute nothing to entity-joined datasets, so those series start thin
and thicken as runs accrue.
"""

import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from backend.app.services.ingestion import parse_feed_date

# Corporate suffixes and geography that make one entity read as several:
# "NNPC" / "NNPC Limited" / "NNPC Ltd" were three Companies rows splitting
# one mention count. Word-boundary, order-insensitive, applied repeatedly
# so "Unilever Nigeria PLC" folds all the way down to "unilever".
_ENTITY_NOISE_RE = re.compile(
    r"\b(plc|ltd|limited|inc|llc|gte|group|holdings?|nigeria|nigerian)\b\.?",
    re.IGNORECASE,
)


def entity_key(name: Any) -> str:
    """Normalised identity key for an entity name.

    Lowercases, strips corporate suffixes/geography and punctuation, and
    collapses whitespace -- but never to nothing: a name made entirely of
    noise words (e.g. the company actually called "Nigeria Ltd") keeps its
    plain lowercased form rather than colliding with every other one.
    """
    raw = str(name or "").strip().lower()
    stripped = _ENTITY_NOISE_RE.sub(" ", raw)
    stripped = re.sub(r"[^\w\s]", " ", stripped)
    stripped = re.sub(r"\s+", " ", stripped).strip()
    return stripped or re.sub(r"\s+", " ", raw)


def _int_cell(value: Any) -> int:
    try:
        return int(float(str(value).strip() or 0))
    except (TypeError, ValueError):
        return 0


def _number(value: Any) -> Optional[float]:
    """Loose numeric parse: '12.5%', '12,500', 40 -> float, else None."""
    s = str(value if value is not None else "").strip().replace("%", "").replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _split_entities(cell: Any) -> List[str]:
    return [n.strip() for n in str(cell or "").split("|") if n.strip()]


def _article_entities(row: Dict[str, Any]) -> List[Tuple[str, str]]:
    """(key, surface label) pairs an article row attributes, deduped."""
    out, seen = [], set()
    for name in _split_entities(row.get("Entities")):
        key = entity_key(name)
        if key and key not in seen:
            seen.add(key)
            out.append((key, name))
    return out


def _is_published(row: Dict[str, Any]) -> bool:
    return str(row.get("Status", "")).strip().lower() != "filtered"


def _week_start(stamp: datetime) -> str:
    """ISO Monday of the stamp's week, as YYYY-MM-DD."""
    monday = stamp.date() - timedelta(days=stamp.weekday())
    return monday.strftime("%Y-%m-%d")


def entity_timeline(article_rows: List[Dict[str, Any]], top_n: int = 300) -> List[Dict[str, Any]]:
    """Weekly mention/risk series per entity, from the Entities linkage.

    Turns "Last Seen 2026-07-24" into a trajectory: for the ``top_n``
    entities by total joined mentions, one point per ISO week with the
    mention count and the mean/max risk score of the mentioning articles.
    """
    per_entity: Dict[str, Dict[str, Any]] = {}
    for row in article_rows or []:
        if not _is_published(row):
            continue
        stamp = parse_feed_date(row.get("Time"))
        if stamp is None:
            continue
        week = _week_start(stamp)
        risk = _int_cell(row.get("Risk Score"))
        for key, label in _article_entities(row):
            e = per_entity.setdefault(key, {"key": key, "label": label, "weeks": {}})
            if len(label) > len(e["label"]):
                e["label"] = label
            w = e["weeks"].setdefault(week, {"week": week, "mentions": 0,
                                             "risk_sum": 0, "max_risk": 0})
            w["mentions"] += 1
            w["risk_sum"] += risk
            w["max_risk"] = max(w["max_risk"], risk)

    entities = []
    for e in per_entity.values():
        points = []
        total = 0
        for week in sorted(e["weeks"]):
            w = e["weeks"][week]
            total += w["mentions"]
            points.append({
                "week": w["week"],
                "mentions": w["mentions"],
                "avg_risk": round(w["risk_sum"] / w["mentions"], 1),
                "max_risk": w["max_risk"],
            })
        entities.append({"key": e["key"], "label": e["label"],
                         "total_mentions": total, "points": points})
    entities.sort(key=lambda e: (-e["total_mentions"], e["label"]))
    return entities[:top_n]


def cooccurrence(article_rows: List[Dict[str, Any]], window_days: int = 90,
                 min_weight: int = 2, max_edges: int = 400,
                 now: datetime = None) -> Dict[str, Any]:
    """Implied network: entities named together in the same article.

    The knowledge graph only carries explicitly-extracted relations
    (person->org, psc->company, contractor->agency); co-mention weight is
    the cheap route to the implied corporate network around them. Edges
    below ``min_weight`` co-mentions are noise and dropped.
    """
    now = now or datetime.now()
    cutoff = now - timedelta(days=window_days)
    pair_weight: Dict[Tuple[str, str], int] = {}
    labels: Dict[str, str] = {}

    for row in article_rows or []:
        if not _is_published(row):
            continue
        stamp = parse_feed_date(row.get("Time"))
        if stamp is None or stamp.replace(tzinfo=None) < cutoff:
            continue
        ents = _article_entities(row)
        for key, label in ents:
            if len(label) > len(labels.get(key, "")):
                labels[key] = label
        for i in range(len(ents)):
            for j in range(i + 1, len(ents)):
                pair = tuple(sorted((ents[i][0], ents[j][0])))
                pair_weight[pair] = pair_weight.get(pair, 0) + 1

    edges = [{"a": a, "b": b, "weight": w}
             for (a, b), w in pair_weight.items() if w >= min_weight]
    edges.sort(key=lambda e: (-e["weight"], e["a"], e["b"]))
    edges = edges[:max_edges]

    used = {e["a"] for e in edges} | {e["b"] for e in edges}
    nodes = [{"key": k, "label": labels[k]} for k in sorted(used)]
    return {"window_days": window_days, "nodes": nodes, "edges": edges}


def risk_movers(article_rows: List[Dict[str, Any]], window_days: int = 7,
                min_mentions: int = 2, top_n: int = 20,
                now: datetime = None) -> List[Dict[str, Any]]:
    """Entities whose mean article risk moved most, week over week.

    The Companies Risk Level is deliberately a monotonic max -- it can
    never go down -- so no risk-direction signal exists anywhere else.
    Mirrors trends.py's two-window design: [now-7d, now] against
    [now-14d, now-7d), requiring ``min_mentions`` in the recent window.
    Entities with no prior-window mentions are reported as new (null
    previous/delta) rather than invented into a delta.
    """
    now = now or datetime.now()
    recent_cut = now - timedelta(days=window_days)
    prev_cut = now - timedelta(days=2 * window_days)
    stats: Dict[str, Dict[str, Any]] = {}

    for row in article_rows or []:
        if not _is_published(row):
            continue
        stamp = parse_feed_date(row.get("Time"))
        if stamp is None:
            continue
        stamp = stamp.replace(tzinfo=None)
        if stamp < prev_cut:
            continue
        bucket = "recent" if stamp >= recent_cut else "previous"
        risk = _int_cell(row.get("Risk Score"))
        for key, label in _article_entities(row):
            s = stats.setdefault(key, {"key": key, "label": label,
                                       "recent": [], "previous": []})
            if len(label) > len(s["label"]):
                s["label"] = label
            s[bucket].append(risk)

    movers = []
    for s in stats.values():
        if len(s["recent"]) < min_mentions:
            continue
        recent_avg = round(sum(s["recent"]) / len(s["recent"]), 1)
        if s["previous"]:
            previous_avg = round(sum(s["previous"]) / len(s["previous"]), 1)
            delta = round(recent_avg - previous_avg, 1)
        else:
            previous_avg = None
            delta = None
        movers.append({
            "key": s["key"], "label": s["label"],
            "recent_avg": recent_avg, "previous_avg": previous_avg,
            "delta": delta,
            "recent_mentions": len(s["recent"]),
            "previous_mentions": len(s["previous"]),
        })
    # Real deltas first (largest magnitude), then new entrants by risk.
    movers.sort(key=lambda m: (m["delta"] is None,
                               -abs(m["delta"]) if m["delta"] is not None else -m["recent_avg"]))
    return movers[:top_n]


def sector_rollup(company_rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Per-Industry entity counts, summed mentions and risk distribution.

    Thin until post-fix rows accrue (Industry was hardcoded "General" for
    every company historically), which is the argument for exporting it
    now: the series has to start somewhere.
    """
    sectors: Dict[str, Dict[str, Any]] = {}
    for row in company_rows or []:
        industry = str(row.get("Industry", "")).strip() or "General"
        s = sectors.setdefault(industry, {"industry": industry, "companies": 0,
                                          "mentions": 0, "risk": {}})
        s["companies"] += 1
        s["mentions"] += _int_cell(row.get("Mention Count"))
        level = str(row.get("Risk Level", "")).strip() or "Unknown"
        s["risk"][level] = s["risk"].get(level, 0) + 1
    out = sorted(sectors.values(), key=lambda s: (-s["mentions"], s["industry"]))
    return out


_DIRECT_HOLDING_RE = re.compile(r"^\s*direct\s+holding\s*$", re.IGNORECASE)


def _intermediates(cell: Any) -> List[str]:
    raw = str(cell or "").strip()
    if not raw or _DIRECT_HOLDING_RE.match(raw):
        return []
    parts = re.split(r"\s*(?:,|;|->|→)\s*", raw)
    return [p for p in (part.strip() for part in parts) if p]


def psc_timeline(psc_rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Percentage history per (person, company) from accumulated PSC rows.

    Date is part of the sheet's identity key precisely so re-sightings a
    week apart are kept -- this turns those kept rows into the series the
    register can't show: "control moved from 28.5% to 63.2% over four
    months", which is the actual concealment signal. Undated or
    percentage-less rows contribute nothing.
    """
    holdings: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for row in psc_rows or []:
        person = str(row.get("Person Name", "")).strip()
        company = str(row.get("Company", "")).strip()
        if not person or not company:
            continue
        pct = _number(row.get("Percentage"))
        date = str(row.get("Date", "")).strip()[:10]
        if pct is None or not date:
            continue
        key = (entity_key(person), entity_key(company))
        h = holdings.setdefault(key, {"person": person, "company": company,
                                      "points": {}, "intermediates": []})
        # One point per day; a later row for the same day wins (freshest).
        h["points"][date] = pct
        for inter in _intermediates(row.get("Intermediate Entities")):
            if inter not in h["intermediates"]:
                h["intermediates"].append(inter)

    out = []
    for h in holdings.values():
        points = [{"date": d, "pct": h["points"][d]} for d in sorted(h["points"])]
        first, last = points[0]["pct"], points[-1]["pct"]
        out.append({
            "person": h["person"], "company": h["company"],
            "points": points,
            "change": round(last - first, 2),
            "intermediates": h["intermediates"],
        })
    out.sort(key=lambda h: (-abs(h["change"]), -len(h["points"]), h["person"]))
    return out


# --- Procurement amount normalisation -------------------------------------

_AMOUNT_SENTINELS = {"", "none", "n/a", "na", "nil", "unknown", "undisclosed", "tbd"}

_CURRENCY_PREFIXES = (
    ("₦", "NGN"), ("ngn", "NGN"), ("naira", "NGN"),
    ("$", "USD"), ("usd", "USD"), ("us$", "USD"),
    ("£", "GBP"), ("gbp", "GBP"),
    ("€", "EUR"), ("eur", "EUR"),
)

_MULTIPLIERS = {
    "k": 1e3, "thousand": 1e3,
    "m": 1e6, "mn": 1e6, "million": 1e6,
    "b": 1e9, "bn": 1e9, "billion": 1e9,
    "tn": 1e12, "trn": 1e12, "trillion": 1e12,
}

_AMOUNT_RE = re.compile(r"([\d][\d,]*\.?\d*)\s*(k|mn|m|bn|b|trn|tn|thousand|million|billion|trillion)?\b",
                        re.IGNORECASE)


def parse_amount(text: Any) -> Optional[Dict[str, Any]]:
    """Deterministic parse of the free-text Amount cell.

    'N400 Million' -> 400e6 NGN; '$4.5 Billion' -> 4.5e9 USD; '£746
    Million' -> 746e6 GBP; 'N1.5 trillion' -> 1.5e12 NGN. Sentinels
    ('None', 'TBD (Local Pipeline)', 'N/A') and anything with no digits
    return None -- undisclosed stays undisclosed, never zero. A bare
    number with no currency marker is naira: this is Nigerian public
    procurement.
    """
    s = str(text or "").strip()
    low = s.lower()
    if low in _AMOUNT_SENTINELS or low.startswith("tbd"):
        return None

    currency = None
    for prefix, code in _CURRENCY_PREFIXES:
        if prefix in low:
            currency = code
            break
    # A leading bare "N" before a digit is the informal naira sign.
    if currency is None and re.match(r"^\s*n\s*[\d.]", low):
        currency = "NGN"

    match = _AMOUNT_RE.search(s.replace(",", ""))
    if not match:
        return None
    try:
        value = float(match.group(1))
    except ValueError:
        return None
    unit = (match.group(2) or "").lower()
    value *= _MULTIPLIERS.get(unit, 1)
    return {"value": value, "currency": currency or "NGN"}


def procurement_rollup(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Contract totals by agency and by contractor, per currency.

    Currencies are never summed across each other; undisclosed amounts
    are counted, not zeroed into the totals.
    """
    def bucket(store: Dict[str, Dict[str, Any]], name: str, parsed):
        b = store.setdefault(name, {"name": name, "contracts": 0,
                                    "undisclosed": 0, "totals": {}})
        b["contracts"] += 1
        if parsed is None:
            b["undisclosed"] += 1
        else:
            cur = parsed["currency"]
            b["totals"][cur] = b["totals"].get(cur, 0) + parsed["value"]

    agencies: Dict[str, Dict[str, Any]] = {}
    contractors: Dict[str, Dict[str, Any]] = {}
    for row in rows or []:
        parsed = parse_amount(row.get("Amount"))
        agency = str(row.get("Agency", "")).strip()
        contractor = str(row.get("Contractor", "")).strip()
        if agency:
            bucket(agencies, agency, parsed)
        if contractor:
            bucket(contractors, contractor, parsed)

    def ranked(store):
        return sorted(store.values(),
                      key=lambda b: (-b["totals"].get("NGN", 0), -b["contracts"], b["name"]))

    return {"agencies": ranked(agencies), "contractors": ranked(contractors)}


def recent_alerts(alert_rows: List[Dict[str, Any]], window_days: int = 90,
                  now: datetime = None) -> List[Dict[str, Any]]:
    """The alerts ledger's exportable window, newest and worst first."""
    now = now or datetime.now()
    cutoff = (now - timedelta(days=window_days)).strftime("%Y-%m-%d")
    out = []
    for row in alert_rows or []:
        date = str(row.get("Date", "")).strip()[:10]
        if not date or date < cutoff:
            continue
        out.append({
            "date": date,
            "title": str(row.get("Title", "")).strip(),
            "url": str(row.get("URL", "")).strip(),
            "source": str(row.get("Source", "")).strip(),
            "risk_score": _int_cell(row.get("Risk Score")),
            "risk_level": str(row.get("Risk Level", "")).strip(),
            "entities": _split_entities(row.get("Entities")),
        })
    out.sort(key=lambda a: (a["date"], a["risk_score"]), reverse=True)
    return out
