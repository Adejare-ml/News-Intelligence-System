"""Morning email briefing: compose one readable email from the data the
pipeline just exported. Pure composition -- no file reads, no network, no
SMTP here; scripts/send_morning_email.py owns I/O and delivery, so every
formatting decision is testable against fixture dicts.

Content contract mirrors the dashboard's honesty rules: nothing invented,
counts come from the exports as-is, a quiet morning says it was quiet.
"""
import html
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

MAX_ALERTS = 6
MAX_CHANGE_ITEMS = 5


def report_stats_from_markdown(md_text: str) -> Dict[str, str]:
    """Parse the '## Summary Statistics' bullets out of report_latest.md.

    Returns {label: value} exactly as printed ("Total Articles Processed"
    -> "21"). Tolerates the block being absent (old archives) by
    returning {}.
    """
    stats: Dict[str, str] = {}
    in_block = False
    for line in str(md_text or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            in_block = stripped == "## Summary Statistics"
            continue
        if not in_block:
            continue
        m = re.match(r"-\s+\*\*(.+?):\*\*\s*(.+)", stripped)
        if m:
            stats[m.group(1).strip()] = m.group(2).strip()
    return stats


def alerts_last_day(alerts_payload: Optional[Dict[str, Any]],
                    now: datetime) -> List[Dict[str, Any]]:
    """alerts.json entries dated within the last day, worst first."""
    if not alerts_payload:
        return []
    cutoff = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    out = []
    for alert in alerts_payload.get("alerts") or []:
        date = str((alert or {}).get("date", ""))[:10]
        if date >= cutoff:
            out.append(alert)

    def score(alert):
        try:
            return -float(alert.get("risk_score") or 0)
        except (TypeError, ValueError):
            return 0.0
    out.sort(key=score)
    return out


def weather_lines(weather_payload: Optional[Dict[str, Any]]) -> List[str]:
    """'Lagos 26°C, Overcast' per city; [] when the export is absent."""
    lines = []
    for city in (weather_payload or {}).get("cities") or []:
        name = str(city.get("name", "")).strip()
        if not name:
            continue
        parts = [name]
        temp = city.get("temp_c")
        if isinstance(temp, (int, float)):
            parts.append(f"{round(temp)}°C")
        desc = str(city.get("description", "")).strip()
        if desc:
            parts.append(desc)
        lines.append(" ".join(parts[:1]) + " " + ", ".join(parts[1:]))
    return lines


def change_lines(changes: Optional[Dict[str, Any]],
                 cap: int = MAX_CHANGE_ITEMS) -> List[str]:
    """Human lines for the overnight register changes; [] when quiet."""
    if not changes:
        return []
    lines = []

    def psc(entry):
        return f"{entry.get('person', '?')} — {entry.get('company', '?')}"

    for entry in (changes.get("psc_added") or [])[:cap]:
        lines.append(f"PSC added: {psc(entry)}")
    for entry in (changes.get("psc_changed") or [])[:cap]:
        lines.append(f"PSC moved: {psc(entry)} "
                     f"({entry.get('from', '?')}% → {entry.get('to', '?')}%)")
    for entry in (changes.get("psc_removed") or [])[:cap]:
        lines.append(f"PSC no longer listed: {psc(entry)}")
    for name in (changes.get("new_companies") or [])[:cap]:
        lines.append(f"New company tracked: {name}")
    return lines


def fx_line(fx: Optional[Dict[str, Any]]) -> str:
    """'USD ₦1,540.20 · EUR ₦1,662.05 · GBP ₦1,943.10 (2026-09-23)' or ''."""
    latest = (fx or {}).get("latest") or {}
    parts = []
    for currency in ("USD", "EUR", "GBP"):
        value = latest.get(currency)
        if isinstance(value, (int, float)):
            parts.append(f"{currency} ₦{value:,.2f}")
    if not parts:
        return ""
    stamp = ""
    history = (fx or {}).get("history") or []
    if history:
        stamp = str(history[-1].get("date", ""))[:10]
    return " · ".join(parts) + (f" ({stamp})" if stamp else "")


MARKET_LABELS = (("spx", "S&P 500", ""), ("ndx", "Nasdaq 100", ""),
                 ("brent", "Brent", "$"), ("gold", "Gold", "$"),
                 ("btc", "BTC", "$"))


def markets_line(markets: Optional[Dict[str, Any]]) -> str:
    """'S&P 500 6,480 · Brent $67.20 · BTC $112,405 (2026-09-23)' or ''."""
    latest = (markets or {}).get("latest") or {}
    parts = []
    for key, label, prefix in MARKET_LABELS:
        value = latest.get(key)
        if isinstance(value, (int, float)):
            parts.append(f"{label} {prefix}{value:,.2f}")
    if not parts:
        return ""
    history = (markets or {}).get("history") or []
    stamp = str(history[-1].get("date", ""))[:10] if history else ""
    return " · ".join(parts) + (f" ({stamp})" if stamp else "")


def world_lines(world: Optional[Dict[str, Any]], cap: int = 3) -> List[str]:
    """Top world headlines as 'Title (Source)' lines; [] when absent."""
    lines = []
    for item in ((world or {}).get("world") or [])[:cap]:
        title = str((item or {}).get("title", "")).strip()
        if not title:
            continue
        source = str(item.get("source", "")).strip()
        lines.append(title + (f" ({source})" if source else ""))
    return lines


def compose_briefing(weather: Optional[Dict[str, Any]],
                     alerts_payload: Optional[Dict[str, Any]],
                     changes: Optional[Dict[str, Any]],
                     report_stats: Dict[str, str],
                     now: datetime,
                     fx: Optional[Dict[str, Any]] = None,
                     weekly: Optional[Dict[str, Any]] = None,
                     markets: Optional[Dict[str, Any]] = None,
                     world: Optional[Dict[str, Any]] = None,
                     site_url: str = "https://adejare-ml.github.io/News-Intelligence-System/",
                     ) -> Dict[str, str]:
    """Build {subject, text, html} for the morning email.

    Sections render only when they have content; an entirely quiet
    morning still sends (the reader should not have to wonder whether
    silence means "nothing happened" or "the email broke"), it just
    says so.
    """
    alerts = alerts_last_day(alerts_payload, now)[:MAX_ALERTS]
    weather_ls = weather_lines(weather)
    changes_ls = change_lines(changes)
    day = now.strftime("%a %d %b")

    high_risk = report_stats.get("High Risk Signals", "")
    subject_bits = [f"AURA morning brief — {day}"]
    if high_risk and high_risk != "0":
        subject_bits.append(f"{high_risk} high-risk signal"
                            + ("" if high_risk == "1" else "s"))
    elif alerts:
        subject_bits.append(f"{len(alerts)} alert" + ("" if len(alerts) == 1 else "s"))
    if weather_ls:
        subject_bits.append(weather_ls[0])
    subject = ": ".join([subject_bits[0], " · ".join(subject_bits[1:])]) \
        if len(subject_bits) > 1 else subject_bits[0]

    # ---- plain text ----
    fx_ln = fx_line(fx)

    text_parts: List[str] = [f"AURA morning brief — {day}", ""]
    if weather_ls:
        text_parts += ["WEATHER", *["  " + line for line in weather_ls], ""]
    if fx_ln:
        text_parts += ["NAIRA RATES", "  " + fx_ln, ""]
    mkt_ln = markets_line(markets)
    if mkt_ln:
        text_parts += ["MARKETS", "  " + mkt_ln, ""]
    world_ls = world_lines(world)
    if world_ls:
        text_parts += ["WORLD", *["  " + line for line in world_ls], ""]
    if report_stats:
        text_parts.append("LATEST RUN")
        for label, value in report_stats.items():
            text_parts.append(f"  {label}: {value}")
        text_parts.append("")
    if alerts:
        text_parts.append("HIGH-RISK SIGNALS (last 24h)")
        for alert in alerts:
            line = f"  [{alert.get('risk_level') or '?'}] {alert.get('title', 'Untitled')}"
            source = str(alert.get("source", "")).strip()
            if source:
                line += f" ({source})"
            text_parts.append(line)
            url = str(alert.get("url", "")).strip()
            if url:
                text_parts.append(f"    {url}")
        text_parts.append("")
    else:
        text_parts += ["HIGH-RISK SIGNALS (last 24h)", "  None recorded.", ""]
    if changes_ls:
        text_parts += ["REGISTER CHANGES", *["  " + line for line in changes_ls], ""]

    # Monday bonus: point at the wrap the Sunday-night run just wrote,
    # but only while it is actually fresh (<36h) -- a stale link would
    # present last week's edition as news.
    weekly_url = ""
    generated = str((weekly or {}).get("generated", ""))
    if generated:
        try:
            age = now - datetime.strptime(generated[:19], "%Y-%m-%d %H:%M:%S")
            if age < timedelta(hours=36):
                weekly_url = site_url.rstrip("/") + "/data/weekly_wrap.md"
                text_parts += [f"WEEKLY WRAP ({weekly.get('week_start')} to "
                               f"{weekly.get('week_end')})", f"  {weekly_url}", ""]
        except ValueError:
            pass

    text_parts.append(f"Dashboard: {site_url}")
    text = "\n".join(text_parts)

    # ---- HTML (email-client-safe: inline styles, no scripts) ----
    def h(value):
        return html.escape(str(value), quote=True)

    def section(title, inner):
        return (f'<h3 style="margin:18px 0 6px;font-size:13px;'
                f'letter-spacing:.05em;color:#6b7280;">{h(title)}</h3>{inner}')

    body = [f'<h2 style="margin:0 0 4px;">AURA morning brief</h2>'
            f'<p style="margin:0;color:#6b7280;">{h(day)}</p>']
    if weather_ls:
        body.append(section("Weather",
                    "".join(f'<p style="margin:2px 0;">{h(line)}</p>'
                            for line in weather_ls)))
    if fx_ln:
        body.append(section("Naira rates",
                    f'<p style="margin:2px 0;">{h(fx_ln)}</p>'))
    if mkt_ln:
        body.append(section("Markets",
                    f'<p style="margin:2px 0;">{h(mkt_ln)}</p>'))
    if world_ls:
        body.append(section("World",
                    '<ul style="margin:4px 0;padding-left:18px;">'
                    + "".join(f'<li style="margin:2px 0;">{h(line)}</li>'
                              for line in world_ls) + "</ul>"))
    if report_stats:
        rows = "".join(
            f'<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">{h(k)}</td>'
            f'<td style="padding:2px 0;"><strong>{h(v)}</strong></td></tr>'
            for k, v in report_stats.items())
        body.append(section("Latest run",
                    f'<table style="border-collapse:collapse;">{rows}</table>'))
    if alerts:
        items = []
        for alert in alerts:
            title = h(alert.get("title", "Untitled"))
            url = str(alert.get("url", "")).strip()
            if url.startswith("http"):
                title = f'<a href="{h(url)}" style="color:#4f46e5;">{title}</a>'
            meta = " · ".join(p for p in (
                h(alert.get("risk_level") or ""),
                h(str(alert.get("source", "")).strip()),
            ) if p)
            items.append(f'<li style="margin:4px 0;">{title}'
                         + (f'<br><span style="color:#6b7280;font-size:12px;">{meta}</span>'
                            if meta else "") + "</li>")
        body.append(section("High-risk signals (last 24h)",
                    '<ul style="margin:4px 0;padding-left:18px;">' + "".join(items) + "</ul>"))
    else:
        body.append(section("High-risk signals (last 24h)",
                    '<p style="margin:2px 0;color:#6b7280;">None recorded.</p>'))
    if changes_ls:
        body.append(section("Register changes",
                    '<ul style="margin:4px 0;padding-left:18px;">'
                    + "".join(f'<li style="margin:2px 0;">{h(line)}</li>'
                              for line in changes_ls) + "</ul>"))
    if weekly_url:
        body.append(section("Weekly wrap",
                    f'<p style="margin:2px 0;"><a href="{h(weekly_url)}" '
                    f'style="color:#4f46e5;">The week of {h(weekly.get("week_start", ""))} '
                    f'— read the wrap</a></p>'))
    body.append(f'<p style="margin:18px 0 0;"><a href="{h(site_url)}" '
                f'style="color:#4f46e5;">Open the dashboard</a></p>')

    html_doc = ('<div style="font-family:Arial,Helvetica,sans-serif;'
                'font-size:14px;line-height:1.5;color:#111827;'
                'max-width:640px;margin:0 auto;padding:8px;">'
                + "".join(body) + "</div>")
    return {"subject": subject, "text": text, "html": html_doc}
