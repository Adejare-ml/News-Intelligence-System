"""Syndication for the daily brief (Package 12).

Two outbound surfaces, both fed from data the pipeline already produces:

- ``build_rss_feed``: an RSS 2.0 document over the Daily Reports rows,
  one item per compiled edition, linking to that edition's archived
  markdown. Written to ``static/data/feed.xml`` at export time so GitHub
  Pages serves it like every other static artifact -- there is no server
  to render a feed on demand.

- ``post_alert_webhook``: a best-effort POST of this run's high-risk
  articles to a webhook URL supplied via the ``ALERT_WEBHOOK_URL``
  secret. The payload carries both ``text`` (Slack-shaped) and
  ``content`` (Discord-shaped) so either endpoint type works unconfigured.
  No secret, no call; and no failure of this call may ever fail a news
  run.

Both halves are pure-ish and injectable for tests: the feed builder is a
string-in/string-out function, and the webhook poster takes the URL as an
argument -- reading the environment is the caller's job.
"""

import logging
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Any, Dict, List
from xml.sax.saxutils import escape

import requests

logger = logging.getLogger(__name__)

# The canonical deployment; mirrors <link rel="canonical"> in index.html.
SITE_URL = "https://adejare-ml.github.io/News-Intelligence-System"

WEBHOOK_TIMEOUT_SECONDS = 10
MAX_WEBHOOK_ITEMS = 10


def _edition_datetime(row: Dict[str, Any]) -> datetime:
    """Best-effort timestamp of one Daily Reports row, UTC.

    ``Generated`` is written as ``YYYY-MM-DD HH:MM:SS`` by the compiler;
    legacy rows may carry only ``Date``. The pipeline runs on UTC Actions
    runners, so naive stamps are treated as UTC rather than invented into
    a local zone.
    """
    for key, fmt in (("Generated", "%Y-%m-%d %H:%M:%S"), ("Date", "%Y-%m-%d")):
        raw = str(row.get(key, "")).strip()
        if not raw:
            continue
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return datetime.fromtimestamp(0, tz=timezone.utc)


def _edition_description(row: Dict[str, Any]) -> str:
    parts = []
    for label, key in (("articles", "Total Articles"), ("high-risk", "High Risk"),
                       ("appointments", "Appointments"), ("procurement", "Procurement")):
        value = str(row.get(key, "")).strip()
        if value != "":
            parts.append(f"{value} {label}")
    return ("Daily corporate-intelligence brief: " + ", ".join(parts) + ".") if parts \
        else "Daily corporate-intelligence brief."


def build_rss_feed(reports: List[Dict[str, Any]], site_url: str = SITE_URL,
                   limit: int = 30, now: datetime = None) -> str:
    """RSS 2.0 document over the newest ``limit`` report editions.

    Editions with an ``Archive File`` link to that durable markdown
    document; legacy rows without one link to the live brief section.
    Everything interpolated is XML-escaped, and the guid is the archive
    filename (already unique per edition since it carries the run time).
    """
    site = str(site_url or SITE_URL).rstrip("/")
    now = now or datetime.now(timezone.utc)

    ordered = sorted(reports or [], key=_edition_datetime, reverse=True)[:limit]

    items = []
    for row in ordered:
        stamp = _edition_datetime(row)
        archive = str(row.get("Archive File", "")).strip()
        link = f"{site}/data/archives/{archive}" if archive else f"{site}/#brief"
        guid = archive or f"edition-{stamp.strftime('%Y%m%d%H%M%S')}"
        title = f"AURA brief — {stamp.strftime('%d %b %Y, %H:%M UTC')}"
        items.append(
            "    <item>\n"
            f"      <title>{escape(title)}</title>\n"
            f"      <link>{escape(link)}</link>\n"
            f"      <guid isPermaLink=\"false\">{escape(guid)}</guid>\n"
            f"      <pubDate>{escape(format_datetime(stamp))}</pubDate>\n"
            f"      <description>{escape(_edition_description(row))}</description>\n"
            "    </item>"
        )

    return (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<rss version=\"2.0\" xmlns:atom=\"http://www.w3.org/2005/Atom\">\n"
        "  <channel>\n"
        "    <title>AURA Daily Intelligence Brief</title>\n"
        f"    <link>{escape(site)}/</link>\n"
        f"    <atom:link href=\"{escape(site)}/data/feed.xml\" rel=\"self\" type=\"application/rss+xml\"/>\n"
        "    <description>Corporate ownership transparency in Nigeria: beneficial owners, "
        "board changes, procurement and regulatory actions, compiled four times a day.</description>\n"
        "    <language>en</language>\n"
        f"    <lastBuildDate>{escape(format_datetime(now))}</lastBuildDate>\n"
        + ("\n".join(items) + ("\n" if items else ""))
        + "  </channel>\n"
        "</rss>\n"
    )


def high_risk_alerts(records: List[Dict[str, Any]],
                     threshold: float = 70.0) -> List[Dict[str, Any]]:
    """This run's webhook-worthy records, worst first.

    Mirrors the dashboard's critical banding: risk_level High/Critical, or
    a numeric risk_score at/above the same >=70 threshold app.js uses.
    """
    out = []
    for record in records or []:
        analysis = (record or {}).get("analysis") or {}
        level = str(analysis.get("risk_level", "")).strip().lower()
        try:
            score = float(analysis.get("risk_score") or 0)
        except (TypeError, ValueError):
            score = 0.0
        if level in ("high", "critical") or score >= threshold:
            out.append({
                "title": str(record.get("title", "")).strip() or "Untitled",
                "url": str(record.get("url", "")).strip(),
                "source": str(record.get("source", "")).strip(),
                "risk_score": score,
                "risk_level": analysis.get("risk_level") or "",
            })
    out.sort(key=lambda a: -a["risk_score"])
    return out


def format_alert_message(alerts: List[Dict[str, Any]],
                         cap: int = MAX_WEBHOOK_ITEMS) -> str:
    """Plain-text webhook body; readable as-is in Slack and Discord."""
    count = len(alerts)
    lines = [f"AURA: {count} high-risk article{'s' if count != 1 else ''} this run"]
    for alert in alerts[:cap]:
        score = f" ({alert['risk_score']:.0f}/100)" if alert.get("risk_score") else ""
        source = f" — {alert['source']}" if alert.get("source") else ""
        lines.append(f"• {alert['title']}{score}{source}")
        if alert.get("url"):
            lines.append(f"  {alert['url']}")
    if count > cap:
        lines.append(f"…and {count - cap} more.")
    return "\n".join(lines)


def post_alert_webhook(webhook_url: str, alerts: List[Dict[str, Any]]) -> bool:
    """POST this run's high-risk summary to the configured webhook.

    Returns True only when a request was sent and acknowledged. Every
    other outcome -- no URL configured, nothing to report, network or
    HTTP failure -- is a logged no-op, because an alerting side channel
    must never be able to fail the pipeline it reports on.
    """
    url = str(webhook_url or "").strip()
    if not url:
        return False
    if not alerts:
        return False
    message = format_alert_message(alerts)
    try:
        response = requests.post(
            url,
            json={"text": message, "content": message},
            timeout=WEBHOOK_TIMEOUT_SECONDS,
        )
        if response.status_code >= 300:
            logger.warning(f"Alert webhook returned HTTP {response.status_code}.")
            return False
        logger.info(f"Alert webhook delivered ({len(alerts)} item(s)).")
        return True
    except Exception as exc:
        logger.warning(f"Alert webhook failed: {exc}")
        return False


# ---------------------------------------------------------------------------
# ntfy.sh push notifications
# ---------------------------------------------------------------------------

MAX_NTFY_ITEMS = 5  # one push per record lands on a phone; cap harder than the webhook


def _ascii_header(value: str, fallback: str = "AURA alert") -> str:
    """HTTP headers are latin-1; a naira sign in a title must not raise."""
    cleaned = "".join(ch for ch in str(value or "") if 32 <= ord(ch) < 127).strip()
    return cleaned or fallback


def ntfy_payloads(alerts: List[Dict[str, Any]],
                  cap: int = MAX_NTFY_ITEMS) -> List[Dict[str, Any]]:
    """One ntfy request per high-risk record: body + headers, pure.

    The full unicode title lives in the body (UTF-8 is fine there); the
    Title header gets an ASCII-sanitised copy because requests encodes
    headers as latin-1. Critical maps to ntfy priority 5 (urgent), the
    rest of the high band to 4.
    """
    payloads = []
    for alert in (alerts or [])[:cap]:
        level = str(alert.get("risk_level", "")).strip().lower()
        priority = "5" if level == "critical" else "4"
        title = str(alert.get("title", "")).strip() or "Untitled"
        source = str(alert.get("source", "")).strip()
        score = alert.get("risk_score")
        body_lines = [title]
        meta = " · ".join(part for part in (
            source,
            f"risk {int(score)}" if isinstance(score, (int, float)) else "",
            (alert.get("risk_level") or "").strip(),
        ) if part)
        if meta:
            body_lines.append(meta)
        headers = {
            "Title": _ascii_header(title),
            "Priority": priority,
            "Tags": "rotating_light" if priority == "5" else "warning",
        }
        url = str(alert.get("url", "")).strip()
        if url.startswith("http"):
            headers["Click"] = url
        payloads.append({"body": "\n".join(body_lines), "headers": headers})
    return payloads


def post_ntfy_alerts(topic_url: str, alerts: List[Dict[str, Any]]) -> int:
    """Push this run's high-risk records to an ntfy topic, one per record.

    Same contract as post_alert_webhook: unset topic, nothing to send,
    and every failure are logged no-ops -- an alerting side channel must
    never be able to fail the pipeline it reports on. Returns how many
    pushes were acknowledged.
    """
    url = str(topic_url or "").strip()
    if not url or not alerts:
        return 0
    delivered = 0
    for payload in ntfy_payloads(alerts):
        try:
            response = requests.post(
                url,
                data=payload["body"].encode("utf-8"),
                headers=payload["headers"],
                timeout=WEBHOOK_TIMEOUT_SECONDS,
            )
            if response.status_code < 300:
                delivered += 1
            else:
                logger.warning(f"ntfy push returned HTTP {response.status_code}.")
        except Exception as exc:
            logger.warning(f"ntfy push failed: {exc}")
    if delivered:
        logger.info(f"ntfy delivered {delivered} push(es).")
    return delivered
