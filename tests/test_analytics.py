"""Package 22: the derived-analytics functions behind the new exports
(entity_timeline / cooccurrence / risk_movers / sectors / psc_timeline /
procurement_rollup / alerts), plus the amount parser and the new sheet
columns. All pure; no Sheets, no network.
"""
from datetime import datetime

from backend.app.services.analytics import (
    cooccurrence,
    entity_key,
    entity_timeline,
    parse_amount,
    procurement_rollup,
    psc_timeline,
    recent_alerts,
    risk_movers,
    sector_rollup,
)
from backend.app.db.excel_db import SHEETS_CONFIG, plan_header_migration

NOW = datetime(2026, 9, 14, 12, 0, 0)


def art(time, entities, risk=40, status="Unread"):
    return {"Time": time, "Entities": entities, "Risk Score": risk, "Status": status}


class TestEntityKeyMoved:
    def test_same_rule_reexported_by_run_pipeline(self):
        import run_pipeline
        assert run_pipeline.entity_key is entity_key
        assert entity_key("NNPC Limited") == entity_key("NNPC") == "nnpc"
        assert entity_key("Nigeria Ltd")  # all-noise names never collapse to ""


class TestEntityTimeline:
    def test_weekly_buckets_with_risk_stats(self):
        rows = [
            art("2026-09-01T10:00:00", "NNPC|Ada Obi", risk=40),   # Tue, week of 08-31
            art("2026-09-03T10:00:00", "NNPC Limited", risk=80),   # same week, same entity
            art("2026-09-08T10:00:00", "NNPC", risk=20),           # next week
            art("2026-09-08T11:00:00", "Chelsea FC", risk=90, status="Filtered"),
        ]
        entities = entity_timeline(rows)
        nnpc = next(e for e in entities if e["key"] == "nnpc")
        assert nnpc["label"] == "NNPC Limited"  # longest surface form wins
        assert nnpc["total_mentions"] == 3
        assert [p["week"] for p in nnpc["points"]] == ["2026-08-31", "2026-09-07"]
        assert nnpc["points"][0] == {"week": "2026-08-31", "mentions": 2,
                                     "avg_risk": 60.0, "max_risk": 80}
        assert all(e["key"] != entity_key("Chelsea FC") for e in entities), \
            "filtered rows contribute nothing"

    def test_top_n_caps_by_total_mentions(self):
        rows = [art("2026-09-01T10:00:00", "A|B"), art("2026-09-02T10:00:00", "A")]
        assert [e["key"] for e in entity_timeline(rows, top_n=1)] == ["a"]

    def test_rows_without_entities_or_dates_are_skipped(self):
        assert entity_timeline([art("", "X"), art("2026-09-01T10:00:00", "")]) == []


class TestCooccurrence:
    def test_pairs_weighted_and_thresholded(self):
        rows = [
            art("2026-09-01T10:00:00", "NNPC|Ada Obi|EFCC"),
            art("2026-09-02T10:00:00", "NNPC Ltd|Ada Obi"),
            art("2026-09-03T10:00:00", "NNPC|Zenith Bank"),  # weight-1 pair drops
        ]
        net = cooccurrence(rows, now=NOW)
        assert net["edges"] == [{"a": "ada obi", "b": "nnpc", "weight": 2}]
        assert [n["key"] for n in net["nodes"]] == ["ada obi", "nnpc"]

    def test_window_excludes_old_articles(self):
        rows = [art("2026-01-01T10:00:00", "A|B"), art("2026-01-02T10:00:00", "A|B")]
        assert cooccurrence(rows, window_days=90, now=NOW)["edges"] == []


class TestRiskMovers:
    def test_delta_between_the_two_windows(self):
        rows = [
            art("2026-09-12T10:00:00", "NNPC", risk=80),
            art("2026-09-13T10:00:00", "NNPC", risk=90),
            art("2026-09-03T10:00:00", "NNPC", risk=30),
            art("2026-09-04T10:00:00", "NNPC", risk=50),
        ]
        movers = risk_movers(rows, now=NOW)
        assert movers[0]["key"] == "nnpc"
        assert movers[0]["recent_avg"] == 85.0
        assert movers[0]["previous_avg"] == 40.0
        assert movers[0]["delta"] == 45.0

    def test_new_entrants_carry_null_previous_and_rank_after_real_deltas(self):
        rows = [
            art("2026-09-12T10:00:00", "Mover", risk=60),
            art("2026-09-13T10:00:00", "Mover", risk=60),
            art("2026-09-04T10:00:00", "Mover", risk=50),
            art("2026-09-12T11:00:00", "Fresh Co", risk=95),
            art("2026-09-13T11:00:00", "Fresh Co", risk=95),
        ]
        movers = risk_movers(rows, now=NOW)
        assert [m["key"] for m in movers] == ["mover", "fresh co"]
        fresh = movers[1]
        assert fresh["previous_avg"] is None and fresh["delta"] is None

    def test_min_mentions_gate(self):
        rows = [art("2026-09-13T10:00:00", "Once", risk=99)]
        assert risk_movers(rows, now=NOW) == []


class TestSectorRollup:
    def test_counts_mentions_and_risk_distribution(self):
        rows = [
            {"Industry": "Banking", "Mention Count": 10, "Risk Level": "High"},
            {"Industry": "Banking", "Mention Count": "5", "Risk Level": "Low"},
            {"Industry": "", "Mention Count": 1, "Risk Level": ""},
        ]
        sectors = sector_rollup(rows)
        assert sectors[0] == {"industry": "Banking", "companies": 2, "mentions": 15,
                              "risk": {"High": 1, "Low": 1}}
        assert sectors[1]["industry"] == "General"
        assert sectors[1]["risk"] == {"Unknown": 1}


class TestPscTimeline:
    def test_percentage_series_and_change(self):
        rows = [
            {"Person Name": "Ada Obi", "Company": "HoldCo Ltd", "Percentage": "28.5%",
             "Date": "2026-05-01", "Intermediate Entities": "Mauritius HoldCo"},
            {"Person Name": "Ada Obi", "Company": "HoldCo", "Percentage": "63.2",
             "Date": "2026-09-01", "Intermediate Entities": "Direct Holding"},
            {"Person Name": "Ada Obi", "Company": "HoldCo", "Percentage": "",
             "Date": "2026-09-02"},  # no pct -> no point
        ]
        holdings = psc_timeline(rows)
        assert len(holdings) == 1
        h = holdings[0]
        assert [p["pct"] for p in h["points"]] == [28.5, 63.2]
        assert h["change"] == 34.7
        assert h["intermediates"] == ["Mauritius HoldCo"]  # "Direct Holding" is not a vehicle

    def test_same_day_resighting_keeps_one_point(self):
        rows = [
            {"Person Name": "A", "Company": "C", "Percentage": "10", "Date": "2026-09-01"},
            {"Person Name": "A", "Company": "C", "Percentage": "12", "Date": "2026-09-01"},
        ]
        assert psc_timeline(rows)[0]["points"] == [{"date": "2026-09-01", "pct": 12.0}]


class TestParseAmount:
    def test_the_shapes_in_the_real_sheet(self):
        assert parse_amount("N400 Million") == {"value": 400e6, "currency": "NGN"}
        assert parse_amount("$4.5 Billion") == {"value": 4.5e9, "currency": "USD"}
        assert parse_amount("£746 Million") == {"value": 746e6, "currency": "GBP"}
        assert parse_amount("N1.5 trillion") == {"value": 1.5e12, "currency": "NGN"}
        assert parse_amount("₦2,500,000") == {"value": 2.5e6, "currency": "NGN"}
        assert parse_amount("N400m") == {"value": 400e6, "currency": "NGN"}
        assert parse_amount("N2bn") == {"value": 2e9, "currency": "NGN"}

    def test_bare_numbers_default_to_naira(self):
        assert parse_amount("500 million") == {"value": 500e6, "currency": "NGN"}

    def test_undisclosed_is_none_never_zero(self):
        for raw in ("None", "N/A", "TBD (Local Pipeline)", "", None, "Undisclosed",
                    "no figure stated"):
            assert parse_amount(raw) is None


class TestProcurementRollup:
    def test_totals_per_currency_and_undisclosed_counted(self):
        rows = [
            {"Agency": "BPP", "Contractor": "Acme", "Amount": "N1bn"},
            {"Agency": "BPP", "Contractor": "Acme", "Amount": "$2m"},
            {"Agency": "BPP", "Contractor": "Zen", "Amount": "None"},
        ]
        roll = procurement_rollup(rows)
        bpp = roll["agencies"][0]
        assert bpp["contracts"] == 3
        assert bpp["undisclosed"] == 1
        assert bpp["totals"] == {"NGN": 1e9, "USD": 2e6}
        acme = next(c for c in roll["contractors"] if c["name"] == "Acme")
        assert acme["totals"]["NGN"] == 1e9


class TestRecentAlerts:
    def test_window_and_ordering(self):
        rows = [
            {"Date": "2026-09-13", "Title": "B", "URL": "u2", "Source": "s",
             "Risk Score": 75, "Risk Level": "High", "Entities": "NNPC|EFCC"},
            {"Date": "2026-09-13", "Title": "A", "URL": "u1", "Source": "s",
             "Risk Score": 90, "Risk Level": "Critical", "Entities": ""},
            {"Date": "2025-01-01", "Title": "Old", "URL": "u0", "Source": "s",
             "Risk Score": 99, "Risk Level": "Critical", "Entities": ""},
        ]
        alerts = recent_alerts(rows, window_days=90, now=NOW)
        assert [a["title"] for a in alerts] == ["A", "B"]
        assert alerts[1]["entities"] == ["NNPC", "EFCC"]


class TestNewSheetColumns:
    def test_alerts_tab_and_new_columns_exist(self):
        assert "Alerts" in SHEETS_CONFIG
        assert SHEETS_CONFIG["Companies"][-1] == "First Seen", \
            "must stay LAST: _add_company_locked updates cells by index 2..5"
        assert "Date" in SHEETS_CONFIG["Procurement"]

    def test_procurement_migration_adds_date(self):
        old = ["Agency", "Contractor", "Amount", "Project", "Source"]
        plan = plan_header_migration(old, SHEETS_CONFIG["Procurement"])
        assert plan["added"] == ["Date"] and plan["removed"] == []


class TestAlertLedgerDedupe:
    def test_add_alert_skips_known_urls(self, monkeypatch, tmp_path):
        from backend.app.db import excel_db
        d = excel_db.SheetsDatabase.__new__(excel_db.SheetsDatabase)
        d.use_local = True
        d.local_path = str(tmp_path / "db.xlsx")
        d._cache = {}
        import threading
        d._lock = threading.RLock()
        import pandas as pd
        with pd.ExcelWriter(d.local_path, engine="openpyxl") as writer:
            pd.DataFrame(columns=excel_db.SHEETS_CONFIG["Alerts"]).to_excel(
                writer, sheet_name="Alerts", index=False)
        alert = {"Date": "2026-09-14", "Title": "T", "URL": "https://x.test/a",
                 "Source": "s", "Risk Score": 80, "Risk Level": "High", "Entities": ""}
        assert d.add_alert(dict(alert)) is True
        assert d.add_alert(dict(alert)) is False, "same URL never re-enters the ledger"
        assert len(d.get_alerts()) == 1
