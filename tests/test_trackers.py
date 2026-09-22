"""Package 29: the naira FX snapshot (fx.py), the Sunday weekly wrap
(weekly.py), and their lines in the morning briefing. All pure.
"""
from datetime import datetime

from backend.app.services.briefing import compose_briefing, fx_line
from backend.app.services.fx import (
    day_change_pct,
    merge_history,
    naira_rates,
)
from backend.app.services.weekly import (
    compose_weekly_wrap,
    week_procurement,
    week_window,
    weekly_totals,
)

NOW = datetime(2026, 9, 27, 23, 5, 0)  # a Sunday, after the 22:00 gate

API_OK = {"result": "success",
          "rates": {"USD": 1.0, "NGN": 1540.5, "EUR": 0.9271, "GBP": 0.7936}}


class TestNairaRates:
    def test_cross_rates_derive_from_the_usd_table(self):
        rates = naira_rates(API_OK)
        assert rates["USD"] == 1540.5
        assert rates["EUR"] == round(1540.5 / 0.9271, 2)
        assert rates["GBP"] == round(1540.5 / 0.7936, 2)

    def test_partial_or_failed_payloads_yield_none_not_zeroes(self):
        assert naira_rates(None) is None
        assert naira_rates({"result": "error"}) is None
        assert naira_rates({"result": "success", "rates": {"NGN": 1540.5}}) is None
        assert naira_rates({"result": "success",
                            "rates": {"NGN": 0, "USD": 1, "EUR": 1, "GBP": 1}}) is None


class TestMergeHistory:
    RATES = {"USD": 1540.5, "EUR": 1661.7, "GBP": 1941.3}

    def test_same_day_rerun_replaces_the_point(self):
        first = merge_history(None, self.RATES, NOW)
        assert len(first["history"]) == 1
        second = merge_history(first, {"USD": 1550.0, "EUR": 1670.0, "GBP": 1950.0}, NOW)
        assert len(second["history"]) == 1
        assert second["latest"]["USD"] == 1550.0

    def test_days_accumulate_sorted_and_capped(self):
        fx = merge_history(None, self.RATES, datetime(2026, 9, 26))
        fx = merge_history(fx, {"USD": 1550.0, "EUR": 1670.0, "GBP": 1950.0}, NOW)
        assert [p["date"] for p in fx["history"]] == ["2026-09-26", "2026-09-27"]
        big = {"history": [{"date": f"2020-01-{d:02d}", "USD": 1.0} for d in range(1, 29)]}
        big["history"] = big["history"] * 14  # 392 points
        merged = merge_history(big, self.RATES, NOW)
        assert len(merged["history"]) <= 365

    def test_failed_fetch_returns_none_so_caller_keeps_old_file(self):
        assert merge_history({"history": []}, None, NOW) is None

    def test_day_change_pct(self):
        fx = {"history": [{"date": "2026-09-26", "USD": 1500.0},
                          {"date": "2026-09-27", "USD": 1530.0}]}
        assert day_change_pct(fx, "USD") == 2.0
        assert day_change_pct({"history": []}, "USD") is None


class TestFxLine:
    def test_formats_rates_with_stamp(self):
        line = fx_line({"latest": {"USD": 1540.5, "EUR": 1661.7, "GBP": 1941.3},
                        "history": [{"date": "2026-09-27"}]})
        assert "USD ₦1,540.50" in line
        assert "(2026-09-27)" in line

    def test_absent_fx_is_empty(self):
        assert fx_line(None) == ""
        assert fx_line({"latest": {}}) == ""


REPORT_ROWS = [
    {"Date": "2026-09-27", "Total Articles": 12, "High Risk": 2,
     "Appointments": 1, "Procurement": 2, "Cascade Failures": 0},
    {"Date": "2026-09-22 13:00:00", "Total Articles": "9", "High Risk": "1",
     "Appointments": 0, "Procurement": 1, "Cascade Failures": 1},
    {"Date": "2026-09-19", "Total Articles": 99, "High Risk": 9,
     "Appointments": 9, "Procurement": 9, "Cascade Failures": 9},  # outside window
]

PROCUREMENT = [
    {"Date": "2026-09-25", "Agency": "BPP", "Contractor": "Acme",
     "Amount": "N2bn", "Project": "Roads"},
    {"Date": "2026-09-10", "Agency": "Old", "Contractor": "Stale",
     "Amount": "N1bn", "Project": "Past"},
]

MOVERS = {"movers": [
    {"label": "Nigeria Customs Service", "delta": 31.4,
     "recent_avg": 41.4, "recent_mentions": 7},
    {"label": "Fresh Co", "delta": None, "recent_avg": 95.0, "recent_mentions": 2},
]}


class TestWeeklyWrap:
    def test_window_and_totals(self):
        window = week_window(NOW)
        assert window == {"start": "2026-09-21", "end": "2026-09-27"}
        totals = weekly_totals(REPORT_ROWS, window)
        assert totals["runs"] == 2
        assert totals["articles"] == 21
        assert totals["high_risk"] == 3
        assert totals["cascade_failures"] == 1

    def test_procurement_filters_to_the_week(self):
        rows = week_procurement(PROCUREMENT, week_window(NOW))
        assert [r["contractor"] for r in rows] == ["Acme"]

    def test_compose_contains_the_sections_and_no_llm_footer(self):
        wrap = compose_weekly_wrap(REPORT_ROWS, MOVERS, PROCUREMENT, NOW)
        md = wrap["markdown"]
        assert wrap["week_start"] == "2026-09-21"
        assert "# AURA Weekly Wrap" in md
        assert "**Articles processed:** 21" in md
        assert "Nigeria Customs Service: ▲ 31.4" in md
        assert "Fresh Co: new this week" in md
        assert "BPP → Acme (N2bn): Roads" in md
        assert "No content in this wrap was generated by a language model." in md

    def test_idle_week_composes_nothing(self):
        assert compose_weekly_wrap([], MOVERS, [], NOW) is None


class TestBriefingWeeklyLink:
    WEEKLY = {"week_start": "2026-09-21", "week_end": "2026-09-27",
              "generated": "2026-09-27 23:10:00"}

    def test_fresh_wrap_links_on_monday_morning(self):
        monday = datetime(2026, 9, 28, 8, 0, 0)
        briefing = compose_briefing(None, None, None, {}, monday, weekly=self.WEEKLY)
        assert "weekly_wrap.md" in briefing["text"]
        assert "weekly_wrap.md" in briefing["html"]

    def test_stale_wrap_never_links(self):
        thursday = datetime(2026, 10, 1, 8, 0, 0)
        briefing = compose_briefing(None, None, None, {}, thursday, weekly=self.WEEKLY)
        assert "weekly_wrap.md" not in briefing["text"]

    def test_fx_section_renders_when_present(self):
        fx = {"latest": {"USD": 1540.5, "EUR": 1661.7, "GBP": 1941.3},
              "history": [{"date": "2026-09-27"}]}
        briefing = compose_briefing(None, None, None, {},
                                    datetime(2026, 9, 28, 8, 0, 0), fx=fx)
        assert "NAIRA RATES" in briefing["text"]
        assert "USD ₦1,540.50" in briefing["html"]
