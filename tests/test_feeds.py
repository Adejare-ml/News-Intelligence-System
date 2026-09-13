"""Tests for backend/app/services/feeds.py (Package 12).

The webhook tests stub requests.post: the sandbox has no network, and a
unit test that talks to a real webhook would be a liability anyway.
"""

from datetime import datetime, timezone
from xml.etree import ElementTree

from backend.app.services import feeds


REPORTS = [
    {"Date": "2026-09-10", "Generated": "2026-09-10 07:15:00",
     "Total Articles": 12, "High Risk": 3, "Appointments": 2, "Procurement": 1,
     "Archive File": "report_20260910_071500.md"},
    {"Date": "2026-09-11", "Generated": "2026-09-11 13:20:00",
     "Total Articles": 8, "High Risk": 0, "Appointments": 1, "Procurement": 0,
     "Archive File": "report_20260911_132000.md"},
    # Legacy row: no archive file, no Generated stamp.
    {"Date": "2026-09-01", "Total Articles": 5, "High Risk": 1},
]


class TestBuildRssFeed:
    def test_valid_xml_with_newest_edition_first(self):
        xml = feeds.build_rss_feed(REPORTS, now=datetime(2026, 9, 13, tzinfo=timezone.utc))
        root = ElementTree.fromstring(xml)  # raises if malformed
        items = root.findall("./channel/item")
        assert len(items) == 3
        assert "11 Sep 2026" in items[0].findtext("title")
        assert "10 Sep 2026" in items[1].findtext("title")

    def test_archive_editions_link_to_their_document(self):
        xml = feeds.build_rss_feed(REPORTS)
        root = ElementTree.fromstring(xml)
        links = [i.findtext("link") for i in root.findall("./channel/item")]
        assert links[0].endswith("/data/archives/report_20260911_132000.md")
        # The legacy row falls back to the live brief.
        assert links[2].endswith("/#brief")

    def test_limit_and_empty_input(self):
        xml = feeds.build_rss_feed(REPORTS, limit=1)
        assert len(ElementTree.fromstring(xml).findall("./channel/item")) == 1
        empty = feeds.build_rss_feed([])
        assert ElementTree.fromstring(empty).findall("./channel/item") == []

    def test_interpolated_values_are_escaped(self):
        hostile = [{"Date": "2026-09-11", "Archive File": 'x".md<script>'}]
        xml = feeds.build_rss_feed(hostile)
        assert "<script>" not in xml
        ElementTree.fromstring(xml)  # still well-formed

    def test_pubdate_is_rfc822_utc(self):
        xml = feeds.build_rss_feed(REPORTS[:1])
        pub = ElementTree.fromstring(xml).findtext("./channel/item/pubDate")
        assert pub.endswith("+0000")
        assert "10 Sep 2026 07:15:00" in pub


class TestHighRiskAlerts:
    RECORDS = [
        {"title": "CBN sanctions bank", "url": "https://p.test/a", "source": "Punch",
         "analysis": {"risk_level": "Critical", "risk_score": 88}},
        {"title": "Quiet earnings note", "url": "https://p.test/b",
         "analysis": {"risk_level": "Standard", "risk_score": 20}},
        {"title": "Score-only breach", "url": "https://p.test/c",
         "analysis": {"risk_level": "", "risk_score": 71}},
        {"title": "Malformed score", "analysis": {"risk_level": "High", "risk_score": "n/a"}},
    ]

    def test_thresholds_mirror_the_dashboard(self):
        alerts = feeds.high_risk_alerts(self.RECORDS)
        assert [a["title"] for a in alerts] == [
            "CBN sanctions bank", "Score-only breach", "Malformed score"]

    def test_worst_first_and_empty_safe(self):
        alerts = feeds.high_risk_alerts(self.RECORDS)
        assert alerts[0]["risk_score"] == 88
        assert feeds.high_risk_alerts([]) == []
        assert feeds.high_risk_alerts(None) == []

    def test_message_caps_and_counts(self):
        many = [{"title": f"T{i}", "url": f"https://p.test/{i}", "source": "S",
                 "analysis": {"risk_level": "High", "risk_score": 80}} for i in range(14)]
        msg = feeds.format_alert_message(feeds.high_risk_alerts(many))
        assert msg.startswith("AURA: 14 high-risk articles this run")
        assert "…and 4 more." in msg


class TestPostAlertWebhook:
    ALERTS = [{"title": "X", "url": "https://p.test/x", "source": "S",
               "risk_score": 90, "risk_level": "Critical"}]

    def test_no_url_and_no_alerts_are_noops(self, monkeypatch):
        def boom(*a, **k):  # pragma: no cover - must not run
            raise AssertionError("no request should be sent")
        monkeypatch.setattr(feeds.requests, "post", boom)
        assert feeds.post_alert_webhook("", self.ALERTS) is False
        assert feeds.post_alert_webhook("   ", self.ALERTS) is False
        assert feeds.post_alert_webhook("https://hooks.test/h", []) is False

    def test_payload_carries_slack_and_discord_keys(self, monkeypatch):
        sent = {}

        class FakeResponse:
            status_code = 200

        def fake_post(url, json=None, timeout=None):
            sent.update({"url": url, "json": json, "timeout": timeout})
            return FakeResponse()

        monkeypatch.setattr(feeds.requests, "post", fake_post)
        assert feeds.post_alert_webhook("https://hooks.test/h", self.ALERTS) is True
        assert sent["json"]["text"] == sent["json"]["content"]
        assert "X (90/100)" in sent["json"]["text"]
        assert sent["timeout"] == feeds.WEBHOOK_TIMEOUT_SECONDS

    def test_network_failure_is_swallowed(self, monkeypatch):
        def fake_post(*a, **k):
            raise OSError("connection refused")
        monkeypatch.setattr(feeds.requests, "post", fake_post)
        assert feeds.post_alert_webhook("https://hooks.test/h", self.ALERTS) is False

    def test_http_error_reports_false(self, monkeypatch):
        class FakeResponse:
            status_code = 404
        monkeypatch.setattr(feeds.requests, "post", lambda *a, **k: FakeResponse())
        assert feeds.post_alert_webhook("https://hooks.test/h", self.ALERTS) is False


class TestFeedDocument:
    def test_self_link_matches_the_published_path(self):
        # index.html's <link rel="alternate"> points at data/feed.xml; the
        # atom:link self-reference inside the document must agree.
        root = ElementTree.fromstring(feeds.build_rss_feed(REPORTS))
        self_link = root.find(
            "./channel/{http://www.w3.org/2005/Atom}link").get("href")
        assert self_link == feeds.SITE_URL + "/data/feed.xml"

    def test_channel_link_is_the_site(self):
        root = ElementTree.fromstring(feeds.build_rss_feed(REPORTS))
        assert root.findtext("./channel/link") == feeds.SITE_URL + "/"
