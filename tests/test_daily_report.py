"""
The executive brief must cover the day, cite its sources, and stay bounded.

The pipeline runs four times a day and each run overwrote report_latest.md
with a brief compiled from only that run's new articles -- the site's front
page routinely ended the day as a one-article stub, and no edition of the 67
archived briefs carried a single source URL. These tests pin the pure pieces
of the fix: reducing today's already-published rows, exact day totals from
the per-run Daily Reports rows, prompt-payload truncation, and the prompt
rules themselves.
"""
from datetime import date

from backend.app.services.llm import build_report_prompt
from run_pipeline import day_totals, published_today, report_payload

TODAY = date(2026, 8, 16)


def _row(time, **over):
    base = {
        "Title": "Some headline",
        "Source": "Punch",
        "URL": "https://punchng.com/x",
        "Category": "Company",
        "Risk Score": 40,
        "Summary": "s",
        "Time": time,
    }
    base.update(over)
    return base


class TestPublishedToday:
    def test_reads_all_three_time_formats_seen_in_the_sheet(self):
        rows = [
            _row("Sun, 16 Aug 2026 08:41:00 GMT"),
            _row("2026-08-16T06:09:20Z"),
            _row("2026-08-16T12:00:00"),
        ]
        assert len(published_today(rows, today=TODAY)) == 3

    def test_excludes_other_days_and_unparseable_times(self):
        rows = [
            _row("2026-08-15T23:59:00"),
            _row("not a date"),
            _row(""),
            _row(None),
            _row("2026-08-16T01:00:00"),
        ]
        assert len(published_today(rows, today=TODAY)) == 1

    def test_reduces_to_report_record_shape(self):
        rec = published_today([_row("2026-08-16T10:00:00")], today=TODAY)[0]
        assert rec["title"] == "Some headline"
        assert rec["url"] == "https://punchng.com/x"
        assert rec["analysis"]["summary"] == "s"
        assert rec["analysis"]["category"] == "Company"

    def test_high_risk_mirrors_the_dashboard_threshold(self):
        rows = [
            _row("2026-08-16T10:00:00", **{"Risk Score": 70}),
            _row("2026-08-16T10:00:00", **{"Risk Score": 69.9}),
            _row("2026-08-16T10:00:00", **{"Risk Score": "82"}),
            _row("2026-08-16T10:00:00", **{"Risk Score": "n/a"}),
        ]
        levels = [r["analysis"]["risk_level"] for r in published_today(rows, today=TODAY)]
        assert levels == ["High", "Standard", "High", "Standard"]


class TestDayTotals:
    def test_sums_only_todays_rows(self):
        rows = [
            {"Date": "2026-08-16", "Total Articles": 5, "High Risk": 1, "Appointments": 2, "Procurement": 0},
            {"Date": "2026-08-16", "Total Articles": "3", "High Risk": 0.0, "Appointments": "0", "Procurement": 1},
            {"Date": "2026-08-15", "Total Articles": 99, "High Risk": 9, "Appointments": 9, "Procurement": 9},
        ]
        totals = day_totals(rows, "2026-08-16")
        assert totals == {"Total Articles": 8, "High Risk": 1, "Appointments": 2, "Procurement": 1}

    def test_tolerates_the_timestamped_date_outlier_rows(self):
        # A historical branch wrote full timestamps into the Date column.
        rows = [{"Date": "2026-08-16 14:01:00", "Total Articles": 2,
                 "High Risk": 0, "Appointments": 0, "Procurement": 0}]
        assert day_totals(rows, "2026-08-16")["Total Articles"] == 2

    def test_garbage_cells_count_as_zero(self):
        rows = [{"Date": "2026-08-16", "Total Articles": "junk",
                 "High Risk": None, "Appointments": "", "Procurement": 4}]
        totals = day_totals(rows, "2026-08-16")
        assert totals["Total Articles"] == 0
        assert totals["Procurement"] == 4

    def test_empty_input(self):
        assert day_totals([], "2026-08-16")["Total Articles"] == 0
        assert day_totals(None, "2026-08-16")["High Risk"] == 0


class TestReportPayload:
    def test_truncates_long_summaries_only(self):
        records = [
            {"title": "a", "source": "s", "url": "u",
             "analysis": {"summary": "x" * 1000, "category": "Company"}},
            {"title": "b", "source": "s", "url": "u",
             "analysis": {"summary": "short", "category": "Company"}},
        ]
        out = report_payload(records, summary_limit=400)
        assert len(out[0]["analysis"]["summary"]) <= 403  # 400 + ellipsis
        assert out[0]["analysis"]["summary"].endswith("...")
        assert out[1]["analysis"]["summary"] == "short"

    def test_does_not_mutate_the_input(self):
        rec = {"title": "a", "source": "s", "url": "u", "analysis": {"summary": "y" * 1000}}
        report_payload([rec])
        assert len(rec["analysis"]["summary"]) == 1000

    def test_keeps_the_fields_the_prompt_cites(self):
        out = report_payload([{"title": "t", "source": "Punch",
                               "url": "https://p.test/a", "analysis": {}}])
        assert out[0]["url"] == "https://p.test/a"
        assert out[0]["source"] == "Punch"


class TestPromptRules:
    def test_requires_source_links_and_forbids_invented_urls(self):
        prompt = build_report_prompt("{}")
        assert "CITE SOURCES" in prompt
        assert "never construct, guess, or shorten" in prompt

    def test_declares_the_coverage_fields_authoritative(self):
        assert "report_date" in build_report_prompt("{}")

    def test_forbids_tables_and_repeated_boilerplate(self):
        prompt = build_report_prompt("{}")
        assert "Never emit markdown tables" in prompt
        assert "boilerplate" in prompt

    def test_embeds_the_data(self):
        assert '"articles": [1, 2]' in build_report_prompt('{"articles": [1, 2]}')
