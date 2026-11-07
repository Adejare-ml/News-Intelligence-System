"""Row shaping for the static exports: node ids, slimming, history,
source health and entity-row dedupe."""

from typing import Any, Dict, List

from backend.app.pipeline.report import _int_cell
from backend.app.services.analytics import entity_key
from backend.app.services.ingestion import parse_feed_date


def make_node_id(text: str) -> str:
    """Returns a deterministic string ID for graph nodes."""
    import hashlib
    return hashlib.md5((text or "").strip().lower().encode("utf-8")).hexdigest()[:12]


def slim_report_rows(reports: List[Dict[str, Any]], keep: int = 120) -> List[Dict[str, Any]]:
    """Rows for reports.json: the newest `keep`, inline markdown stripped
    where the identical bytes already exist as an archive file.

    The exported file had grown to ~570KB of which 90% was the Content
    column -- fetched on every dashboard load, growing ~3.4MB/year, while
    data/archives/ holds the same markdown per edition. Legacy rows that
    predate the Archive File column keep their inline Content, since it is
    the only copy.
    """
    out = []
    for row in (reports or [])[-keep:]:
        r = dict(row)
        if str(r.get("Archive File", "")).strip():
            r["Content"] = ""
        out.append(r)
    return out


def build_history(report_rows: List[Dict[str, Any]], keep_days: int = 365) -> List[Dict[str, Any]]:
    """Per-day rollup of the Daily Reports tab for history.json.

    The health panel previously re-derived a 30-day view client-side by
    parsing 120 heavy report rows; this gives it a year in a small payload,
    and it is the first export to carry the filter funnel (candidates /
    rejected / undated) that the sheet records but nothing rendered.
    Dates compare on their first 10 chars because a historical branch wrote
    full timestamps into the Date column. Pure aggregation over rows the
    exporter already has in memory -- no extra Sheets read.
    """
    days: Dict[str, Dict[str, Any]] = {}
    for row in report_rows or []:
        date = str(row.get("Date", "")).strip()[:10]
        if not date:
            continue
        d = days.setdefault(date, {
            "date": date, "runs": 0, "articles": 0, "high_risk": 0,
            "appointments": 0, "procurement": 0, "cascade_failures": 0,
            "candidates": 0, "rejected": 0, "undated": 0, "run_seconds": 0,
        })
        d["runs"] += 1
        d["articles"] += _int_cell(row.get("Total Articles"))
        d["high_risk"] += _int_cell(row.get("High Risk"))
        d["appointments"] += _int_cell(row.get("Appointments"))
        d["procurement"] += _int_cell(row.get("Procurement"))
        d["cascade_failures"] += _int_cell(row.get("Cascade Failures"))
        d["candidates"] += _int_cell(row.get("Candidates"))
        d["rejected"] += _int_cell(row.get("Rejected"))
        d["undated"] += _int_cell(row.get("Undated"))
        d["run_seconds"] += _int_cell(row.get("Run Seconds"))
    return [days[k] for k in sorted(days)][-keep_days:]


def build_sources(article_rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Per-publisher scorecard over the full Articles history for sources.json.

    The dashboard's engine-mix chart answers "which extractor ran" over the
    newest 60 articles only; this answers, over the whole corpus, which
    feeds actually earn their fetches: volume, accept rate (Filtered rows
    are the rejects), mean risk of what was published, engine mix and the
    most recent sighting. Aggregation only -- no extra Sheets read.
    """
    sources: Dict[str, Dict[str, Any]] = {}
    for row in article_rows or []:
        name = str(row.get("Source", "")).strip() or "Unknown"
        s = sources.setdefault(name, {
            "source": name, "total": 0, "published": 0, "filtered": 0,
            "risk_sum": 0, "risk_n": 0, "engines": {}, "last_seen": "",
        })
        s["total"] += 1
        if str(row.get("Status", "")).strip().lower() == "filtered":
            s["filtered"] += 1
        else:
            s["published"] += 1
            s["risk_sum"] += _int_cell(row.get("Risk Score"))
            s["risk_n"] += 1
            engine = str(row.get("Engine", "")).strip() or "unknown"
            s["engines"][engine] = s["engines"].get(engine, 0) + 1
        stamp = parse_feed_date(row.get("Time"))
        if stamp is not None:
            iso = stamp.strftime("%Y-%m-%d")
            if iso > s["last_seen"]:
                s["last_seen"] = iso
    out = []
    for s in sorted(sources.values(), key=lambda x: (-x["total"], x["source"])):
        out.append({
            "source": s["source"],
            "total": s["total"],
            "published": s["published"],
            "filtered": s["filtered"],
            "accept_rate": round(100.0 * s["published"] / s["total"]) if s["total"] else 0,
            "avg_risk": round(s["risk_sum"] / s["risk_n"], 1) if s["risk_n"] else None,
            "engines": s["engines"],
            "last_seen": s["last_seen"],
        })
    return out


# A configured feed returning nothing this many runs in a row is broken
# (an expired key, a changed endpoint), not having a quiet day.
STALE_SOURCE_RUNS = 3


def merge_source_health(previous: Any, counts: Dict[str, int], now: str) -> Dict[str, Any]:
    """source_health.json: each feed's last fetch count, consecutive empty
    runs and the last run it returned anything, carried run over run.

    Feeds absent from `counts` (keyless, or skipped by the fetch budget)
    keep their previous entry: not running is not the same as failing.
    """
    sources = (previous or {}).get("sources") if isinstance(previous, dict) else None
    merged = {name: dict(entry) for name, entry in sources.items()
              if isinstance(entry, dict)} if isinstance(sources, dict) else {}
    for name, count in counts.items():
        entry = merged.get(name, {})
        if count:
            entry = {"last_count": count, "empty_runs": 0, "last_ok": now}
        else:
            entry = {"last_count": 0,
                     "empty_runs": _int_cell(entry.get("empty_runs")) + 1,
                     "last_ok": entry.get("last_ok", "")}
        merged[name] = entry
    return {"generated": now, "sources": merged}


def stale_sources(health: Dict[str, Any]) -> List[str]:
    """Feeds that have come back empty STALE_SOURCE_RUNS runs in a row."""
    return [name for name, entry in health.get("sources", {}).items()
            if _int_cell(entry.get("empty_runs")) >= STALE_SOURCE_RUNS]


def dedupe_entity_rows(rows: List[Dict[str, Any]], key_fields: List[str],
                       count_key: str = None) -> List[Dict[str, Any]]:
    """Suffix-normalised dedupe of exported entity rows.

    The Companies sheet holds e.g. eight copies of one outlet and People
    734 rows for 627 distinct (name, organization) pairs -- legacy rows
    written before add_company's find-or-update existed -- plus 25
    measured suffix-variant groups ("NNPC" / "NNPC Limited" / "NNPC Ltd").
    First occurrence keeps its position. When `count_key` is given the
    highest-count row wins, its count becomes the SUM across the group
    (the mentions were all of one entity), and the longest surface form
    becomes the label; otherwise the latest duplicate (freshest row) wins.
    """
    best: Dict[Any, Dict[str, Any]] = {}
    counts: Dict[Any, int] = {}
    labels: Dict[Any, str] = {}
    order: List[Any] = []
    for row in rows or []:
        key = tuple(entity_key(row.get(f)) for f in key_fields)
        if not any(key):
            continue
        if count_key:
            counts[key] = counts.get(key, 0) + _int_cell(row.get(count_key))
            surface = str(row.get(key_fields[0], "")).strip()
            if len(surface) > len(labels.get(key, "")):
                labels[key] = surface
        if key not in best:
            best[key] = row
            order.append(key)
        elif count_key:
            if _int_cell(row.get(count_key)) > _int_cell(best[key].get(count_key)):
                best[key] = row
        else:
            best[key] = row
    out = []
    for k in order:
        row = best[k]
        if count_key:
            row = dict(row)
            row[count_key] = counts[k]
            if labels.get(k):
                row[key_fields[0]] = labels[k]
        out.append(row)
    return out


def collapse_identical_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drop rows that repeat an earlier row field-for-field, keeping order.

    The Significant Control tab still holds an exact duplicate pair written
    before add_significant_control learned to refuse repeats (see
    tests/test_psc_dedupe.py). Rows that differ in any field -- a later
    report of the same holding with a new date or stake -- are kept: they
    are history, and the site groups them by holding instead.
    """
    seen = set()
    out = []
    for row in rows or []:
        key = tuple(sorted((str(k), str(v).strip()) for k, v in (row or {}).items()))
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def top_rows(rows: List[Dict[str, Any]], n: int, count_key: str = None,
             date_key: str = None) -> List[Dict[str, Any]]:
    """The N rows most worth graphing, instead of the first N inserted.

    The graph slices used to take `companies[:20]` etc. over sheets in
    insertion order -- a fixed window onto the oldest records. Sorts by
    mention count (when given) then date string (ISO-ish, so lexical works),
    both descending; stable, so ties keep sheet order.
    """
    def sort_key(row):
        count = _int_cell(row.get(count_key)) if count_key else 0
        date = str(row.get(date_key, "")) if date_key else ""
        return (count, date)
    return sorted(rows or [], key=sort_key, reverse=True)[:n]
