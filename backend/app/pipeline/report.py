"""Daily report shaping: what was published today, filter reasons,
entity mentions, day totals and cycle-to-cycle changes."""

from datetime import datetime
from typing import Any, Dict, List

from backend.app.services import story_detail
from backend.app.services.analytics import entity_key
from backend.app.services.ingestion import parse_feed_date
from backend.app.services.relevance import is_publication_or_furniture


def published_today(article_rows: List[Dict[str, Any]], today=None) -> List[Dict[str, Any]]:
    """Reduce today's already-published Articles rows to report-record shape.

    The sheet keeps Title/Source/URL/Category/Risk Score/Summary but not the
    full analysis, so these records carry what a brief needs and nothing that
    would have to be invented. The Time cell arrives in three formats (RFC
    2822, ISO with Z, plain ISO); parse_feed_date already reads all of them.
    """
    today = today or datetime.now().date()
    reduced = []
    for row in article_rows or []:
        # Rejects are written to the same sheet with Status "Filtered";
        # the export path already skips them, but this path fed them back
        # into the day's brief -- and at the observed ~80% reject rate,
        # most of the "coverage" handed to the report model was junk the
        # relevance guard had already thrown out.
        if str(row.get("Status", "")).strip().lower() == "filtered":
            continue
        stamp = parse_feed_date(row.get("Time"))
        if stamp is None or stamp.date() != today:
            continue
        try:
            score = float(str(row.get("Risk Score", "")).strip() or 0)
        except (TypeError, ValueError):
            score = 0.0
        reduced.append({
            "title": row.get("Title"),
            "source": row.get("Source"),
            "url": row.get("URL"),
            "analysis": {
                "summary": row.get("Summary") or "",
                "category": row.get("Category") or "",
                "event_type": row.get("Event Type") or "",
                "risk_score": score,
                # The extractor's own level when the row has it; older rows
                # keep only the score, and >=70 mirrors the dashboard's
                # critical-alert threshold (app.js).
                "risk_level": str(row.get("Risk Level") or "").strip()
                or ("High" if score >= 70 else "Standard"),
                **story_detail.from_row(row),
            },
        })
    return reduced


def _int_cell(value: Any) -> int:
    """Sheet cells come back as int, float, or string; NaN/blank count as 0."""
    try:
        return int(float(str(value).strip() or 0))
    except (TypeError, ValueError):
        return 0


def filter_reason(off_topic) -> str:
    """Compact durable form of an off-topic verdict for the Filter Reason cell."""
    if not off_topic:
        return ""
    matched = ", ".join(off_topic.matched or [])
    return f"{off_topic.topic}: {matched}" if matched else str(off_topic.topic)


def entity_mentions(analysis: Dict[str, Any]) -> str:
    """Pipe-joined canonical entity names an analysis attributes to its article.

    This is the only durable article<->entity linkage: the org/person names
    go to their own sheets without any reference back to the article row.
    Surface names are kept (not entity_key output) so labels stay readable;
    consumers normalise with entity_key when joining. Publications and page
    furniture are excluded the same way the entity sheets exclude them.
    """
    names, seen = [], set()
    for org in analysis.get("organizations") or []:
        name = str((org or {}).get("name") or "").strip()
        if not name or is_publication_or_furniture(name):
            continue
        key = entity_key(name)
        if key not in seen:
            seen.add(key)
            names.append(name)
    for person in analysis.get("people") or []:
        name = str((person or {}).get("name") or "").strip()
        if not name:
            continue
        key = entity_key(name)
        if key not in seen:
            seen.add(key)
            names.append(name)
    return "|".join(names)


def day_totals(report_rows: List[Dict[str, Any]], today_str: str) -> Dict[str, int]:
    """Sum today's earlier per-run Daily Reports rows.

    Each run writes a per-run row (that stays per-run -- it is the time
    series), so the exact day-to-date totals are the sum of today's rows
    plus the current run. Date is compared on its first 10 chars because a
    historical branch wrote full timestamps into the Date column.
    """
    totals = {"Total Articles": 0, "High Risk": 0, "Appointments": 0, "Procurement": 0}
    for row in report_rows or []:
        if str(row.get("Date", "")).strip()[:10] != today_str:
            continue
        for key in totals:
            totals[key] += _int_cell(row.get(key))
    return totals


def report_payload(records: List[Dict[str, Any]], summary_limit: int = 400) -> List[Dict[str, Any]]:
    """Shape records for the report prompt, truncating long summaries.

    A 60-article day would otherwise serialize every full summary into the
    prompt; past ~400 chars a summary stops adding signal and starts
    crowding out other articles' context.
    """
    payload = []
    for r in records or []:
        analysis = dict(r.get("analysis") or {})
        summary = analysis.get("summary")
        if isinstance(summary, str) and len(summary) > summary_limit:
            analysis["summary"] = summary[:summary_limit].rstrip() + "..."
        payload.append({
            "title": r.get("title"),
            "source": r.get("source"),
            "url": r.get("url"),
            "analysis": analysis,
        })
    return payload


def _loose_number(value):
    """Loose numeric parse for sheet cells: '12.5%', '12,5', 40 -> float, else None."""
    s = str(value if value is not None else "").strip().replace("%", "").replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def compute_cycle_changes(prev: Dict[str, Any], curr: Dict[str, Any]) -> Dict[str, Any]:
    """Pure diff between the previous static-JSON snapshot and this run's.

    `prev`/`curr` carry the exported row lists under "articles", "companies",
    "people" and "psc"; missing keys and a missing prev (first run, an old
    deploy) mean empty. Entities key on their name columns, PSC rows on
    (Person Name, Company), articles on URL. Everything returned is sorted
    so the payload is deterministic for a given pair of snapshots.
    """
    prev = prev or {}
    curr = curr or {}

    def names(rows, key):
        return {str(r.get(key, "")).strip() for r in rows or [] if str(r.get(key, "")).strip()}

    new_companies = sorted(names(curr.get("companies"), "Company") - names(prev.get("companies"), "Company"))
    new_people = sorted(names(curr.get("people"), "Name") - names(prev.get("people"), "Name"))

    def psc_key(row):
        return (str(row.get("Person Name", "")).strip().lower(),
                str(row.get("Company", "")).strip().lower())

    def psc_entry(row):
        return {"person": str(row.get("Person Name", "")).strip(),
                "company": str(row.get("Company", "")).strip()}

    prev_psc = {psc_key(r): r for r in prev.get("psc") or [] if any(psc_key(r))}
    curr_psc = {psc_key(r): r for r in curr.get("psc") or [] if any(psc_key(r))}

    psc_added = [psc_entry(r) for k, r in sorted(curr_psc.items()) if k not in prev_psc]
    psc_removed = [psc_entry(r) for k, r in sorted(prev_psc.items()) if k not in curr_psc]
    psc_changed = []
    for k, r in sorted(curr_psc.items()):
        if k not in prev_psc:
            continue
        before = _loose_number(prev_psc[k].get("Percentage"))
        after = _loose_number(r.get("Percentage"))
        if before is not None and after is not None and abs(before - after) > 1e-9:
            entry = psc_entry(r)
            entry["from"] = before
            entry["to"] = after
            psc_changed.append(entry)

    prev_urls = {str(r.get("URL", "")) for r in prev.get("articles") or [] if r.get("URL")}
    new_high_risk = []
    for r in curr.get("articles") or []:
        url = str(r.get("URL", ""))
        if url and url in prev_urls:
            continue
        score = _loose_number(r.get("Risk Score"))
        # 70 mirrors the dashboard's alert threshold (app.js).
        if score is not None and score >= 70:
            new_high_risk.append({"title": str(r.get("Title", "")), "url": url, "risk": score})
    new_high_risk.sort(key=lambda e: (-e["risk"], e["title"]))

    return {
        "new_companies": new_companies,
        "new_people": new_people,
        "psc_added": psc_added,
        "psc_removed": psc_removed,
        "psc_changed": psc_changed,
        "new_high_risk": new_high_risk,
        "counts": {
            "new_companies": len(new_companies),
            "new_people": len(new_people),
            "psc_added": len(psc_added),
            "psc_removed": len(psc_removed),
            "psc_changed": len(psc_changed),
            "new_high_risk": len(new_high_risk),
        },
    }
