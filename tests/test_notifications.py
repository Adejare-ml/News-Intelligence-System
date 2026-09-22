"""Package 28: the morning email composer (briefing.py) and the ntfy
push payload builder (feeds.py). All pure; delivery I/O is exercised
only through its guard rails (unset config short-circuits).
"""
from datetime import datetime

from backend.app.services.briefing import (
    alerts_last_day,
    change_lines,
    compose_briefing,
    report_stats_from_markdown,
    weather_lines,
)
from backend.app.services.feeds import ntfy_payloads, post_ntfy_alerts

NOW = datetime(2026, 9, 23, 8, 0, 0)

REPORT_MD = """# PSC & Company Daily Intelligence Report
**Generated on:** 2026-09-23 08:05:39 (UTC+1)

## Summary Statistics
- **Total Articles Processed:** 21
- **High Risk Signals:** 2
- **Appointments Logged:** 1
- **Procurement Awards:** 3

---
## Something Else
- **Not A Stat:** ignored
"""

ALERTS = {"alerts": [
    {"date": "2026-09-23", "title": "Fresh alert", "url": "https://x.test/a",
     "source": "Punch", "risk_score": 80, "risk_level": "High"},
    {"date": "2026-09-22", "title": "Yesterday evening", "url": "https://x.test/b",
     "source": "Guardian", "risk_score": 95, "risk_level": "Critical"},
    {"date": "2026-09-10", "title": "Stale", "url": "https://x.test/c",
     "source": "s", "risk_score": 99, "risk_level": "Critical"},
]}

WEATHER = {"cities": [
    {"name": "Lagos", "temp_c": 25.8, "description": "Overcast"},
    {"name": "Abuja", "temp_c": 23.3, "description": "Clear sky"},
]}

CHANGES = {"psc_added": [{"person": "Ada Obi", "company": "HoldCo"}],
           "psc_changed": [{"person": "B", "company": "C", "from": 28.5, "to": 63.2}],
           "new_companies": ["Mango Business"]}


class TestReportStats:
    def test_parses_only_the_summary_block(self):
        stats = report_stats_from_markdown(REPORT_MD)
        assert stats["Total Articles Processed"] == "21"
        assert stats["High Risk Signals"] == "2"
        assert "Not A Stat" not in stats

    def test_absent_block_is_empty(self):
        assert report_stats_from_markdown("# no stats here") == {}
        assert report_stats_from_markdown("") == {}


class TestAlertWindow:
    def test_last_day_only_worst_first(self):
        picked = alerts_last_day(ALERTS, NOW)
        assert [a["title"] for a in picked] == ["Yesterday evening", "Fresh alert"]

    def test_missing_payload(self):
        assert alerts_last_day(None, NOW) == []
        assert alerts_last_day({}, NOW) == []


class TestComposition:
    def test_sections_and_subject(self):
        briefing = compose_briefing(WEATHER, ALERTS, CHANGES,
                                    report_stats_from_markdown(REPORT_MD), NOW)
        assert "2 high-risk signals" in briefing["subject"]
        assert "Lagos 26°C" in briefing["subject"]
        text = briefing["text"]
        assert "Yesterday evening" in text and "Stale" not in text
        assert "PSC moved: B — C (28.5% → 63.2%)" in text
        assert "New company tracked: Mango Business" in text
        html_doc = briefing["html"]
        assert "https://x.test/a" in html_doc
        assert "<script" not in html_doc

    def test_quiet_morning_is_honest_not_empty(self):
        briefing = compose_briefing(None, None, None, {}, NOW)
        assert "None recorded." in briefing["text"]
        assert "AURA morning brief" in briefing["subject"]

    def test_html_escapes_article_titles(self):
        hostile = {"alerts": [{"date": "2026-09-23", "title": "<img src=x>",
                               "url": "https://x.test/e", "source": "s",
                               "risk_score": 90, "risk_level": "High"}]}
        briefing = compose_briefing(None, hostile, None, {}, NOW)
        assert "<img src=x>" not in briefing["html"]
        assert "&lt;img" in briefing["html"]

    def test_weather_lines_tolerate_partial_rows(self):
        lines = weather_lines({"cities": [{"name": "Lagos"}, {"name": ""},
                                          {"description": "orphan"}]})
        assert lines == ["Lagos "]
        assert change_lines(None) == []


class TestNtfyPayloads:
    ALERT = {"title": "₦2bn contract probe — Dangote", "url": "https://x.test/n",
             "source": "Punch", "risk_score": 88.0, "risk_level": "Critical"}

    def test_priority_click_and_latin1_safe_title(self):
        payload = ntfy_payloads([self.ALERT])[0]
        assert payload["headers"]["Priority"] == "5"
        assert payload["headers"]["Click"] == "https://x.test/n"
        # requests encodes headers latin-1: the naira sign must be gone
        payload["headers"]["Title"].encode("latin-1")
        # ...but the body keeps the full unicode title
        assert "₦2bn" in payload["body"]
        assert "risk 88" in payload["body"]

    def test_cap_and_high_priority(self):
        alerts = [dict(self.ALERT, risk_level="High", title=f"t{i}") for i in range(9)]
        payloads = ntfy_payloads(alerts)
        assert len(payloads) == 5, "phone pushes cap harder than the webhook"
        assert payloads[0]["headers"]["Priority"] == "4"

    def test_unconfigured_or_empty_is_a_noop(self):
        assert post_ntfy_alerts("", [self.ALERT]) == 0
        assert post_ntfy_alerts("https://ntfy.sh/x", []) == 0
