"""Package 21: the LLM output that used to be discarded at the write site
(event type, importance, risk level, the article<->entity linkage, the
filter reason) is now persisted, and two derived datasets (history.json,
sources.json) are computed from rows the exporter already holds.
"""
import run_pipeline
from run_pipeline import build_history, build_sources, entity_mentions, filter_reason
from backend.app.db.excel_db import SHEETS_CONFIG, plan_header_migration
from backend.app.services.relevance import off_topic_reason


class TestArticlesSchema:
    def test_articles_schema_carries_the_enrichment(self):
        cols = SHEETS_CONFIG["Articles"]
        for col in ("Event Type", "Risk Level", "Importance", "Entities", "Filter Reason"):
            assert col in cols

    def test_migration_from_the_pre_enrichment_header(self):
        old = ["ID", "Time", "Title", "Source", "URL", "Category",
               "Risk Score", "Summary", "Status", "Engine"]
        plan = plan_header_migration(old, SHEETS_CONFIG["Articles"])
        assert plan["needs_migration"]
        assert set(plan["added"]) == {"Event Type", "Risk Level", "Importance",
                                      "Entities", "Filter Reason"}
        assert plan["removed"] == []
        # Old rows keep their values under the old names; new cells are blank.
        row = plan["remap"](["7", "t", "title", "src", "u", "Company", "40", "s", "Unread", "gemini"])
        target = SHEETS_CONFIG["Articles"]
        assert row[target.index("Engine")] == "gemini"
        assert row[target.index("Entities")] == ""


class TestEntityMentions:
    def test_joins_orgs_and_people_pipe_separated(self):
        analysis = {
            "organizations": [{"name": "Dangote Cement Plc", "type": "company"},
                              {"name": "EFCC", "type": "agency"}],
            "people": [{"name": "Ada Obi"}],
        }
        assert entity_mentions(analysis) == "Dangote Cement Plc|EFCC|Ada Obi"

    def test_dedupes_suffix_variants_on_entity_key(self):
        analysis = {
            "organizations": [{"name": "NNPC"}, {"name": "NNPC Limited"}],
            "people": [],
        }
        # One entity, first surface form wins.
        assert entity_mentions(analysis) == "NNPC"

    def test_excludes_publications_and_blank_names(self):
        analysis = {
            "organizations": [{"name": "The Guardian Nigeria News"}, {"name": ""},
                              {"name": "Access Holdings"}],
            "people": [{"name": ""}, None],
        }
        assert entity_mentions(analysis) == "Access Holdings"

    def test_empty_analysis_is_empty_string(self):
        assert entity_mentions({}) == ""


class TestFilterReason:
    def test_formats_topic_and_matches(self):
        verdict = off_topic_reason("Chelsea beat Arsenal in Premier League clash")
        assert verdict is not None
        reason = filter_reason(verdict)
        assert reason.startswith(verdict.topic)
        assert ":" in reason

    def test_none_verdict_is_blank(self):
        assert filter_reason(None) == ""


class TestBuildHistory:
    ROWS = [
        {"Date": "2026-09-01", "Total Articles": 3, "High Risk": 1, "Appointments": 0,
         "Procurement": 1, "Cascade Failures": 0, "Run Seconds": 100,
         "Candidates": 40, "Rejected": 30, "Undated": 2},
        {"Date": "2026-09-01 13:00:00", "Total Articles": "2", "High Risk": "0",
         "Appointments": 1, "Procurement": 0, "Cascade Failures": 1,
         "Run Seconds": "80", "Candidates": "35", "Rejected": "28", "Undated": ""},
        {"Date": "2026-09-02", "Total Articles": 5, "High Risk": 2, "Appointments": 0,
         "Procurement": 0, "Cascade Failures": 0, "Run Seconds": 90,
         "Candidates": 50, "Rejected": 41, "Undated": 1},
    ]

    def test_days_merge_across_runs_and_timestamped_dates(self):
        days = build_history(self.ROWS)
        assert [d["date"] for d in days] == ["2026-09-01", "2026-09-02"]
        first = days[0]
        assert first["runs"] == 2
        assert first["articles"] == 5
        assert first["high_risk"] == 1
        assert first["candidates"] == 75
        assert first["rejected"] == 58
        assert first["undated"] == 2  # blank cell counts 0, not a crash
        assert first["run_seconds"] == 180

    def test_keep_days_caps_from_the_newest_end(self):
        days = build_history(self.ROWS, keep_days=1)
        assert [d["date"] for d in days] == ["2026-09-02"]

    def test_garbage_rows_are_skipped_not_fatal(self):
        assert build_history([{"Date": ""}, {"Total Articles": 4}]) == []
        assert build_history(None) == []


class TestBuildSources:
    ROWS = [
        {"Source": "Punch", "Status": "Unread", "Risk Score": 40, "Engine": "gemini",
         "Time": "2026-09-01T10:00:00Z"},
        {"Source": "Punch", "Status": "Filtered", "Risk Score": 0, "Engine": "pre-llm-guard",
         "Time": "Thu, 10 Sep 2026 23:57:38 GMT"},
        {"Source": "Punch", "Status": "Unread", "Risk Score": 80, "Engine": "nvidia",
         "Time": "2026-09-03T10:00:00Z"},
        {"Source": "Vanguard", "Status": "Filtered", "Risk Score": "", "Engine": "",
         "Time": "not a date"},
    ]

    def test_scorecard_shape_and_ordering(self):
        cards = build_sources(self.ROWS)
        assert [c["source"] for c in cards] == ["Punch", "Vanguard"]
        punch = cards[0]
        assert punch["total"] == 3
        assert punch["published"] == 2
        assert punch["filtered"] == 1
        assert punch["accept_rate"] == 67
        assert punch["avg_risk"] == 60.0  # filtered rows never dilute the mean
        assert punch["engines"] == {"gemini": 1, "nvidia": 1}
        assert punch["last_seen"] == "2026-09-10"  # RFC-822 stamps parse too

    def test_all_filtered_source_has_null_avg_risk(self):
        vanguard = build_sources(self.ROWS)[1]
        assert vanguard["published"] == 0
        assert vanguard["accept_rate"] == 0
        assert vanguard["avg_risk"] is None
        assert vanguard["last_seen"] == ""

    def test_blank_source_buckets_as_unknown(self):
        cards = build_sources([{"Source": " ", "Status": "Unread", "Risk Score": 5,
                                "Engine": "x", "Time": ""}])
        assert cards[0]["source"] == "Unknown"


class TestQuietCycleFunnel:
    def test_module_wires_the_extra_collect_stats_into_reports(self):
        # Both Daily Reports write sites must persist the four counters
        # collect_all computes; a rename in last_collect_stats or the
        # schema would silently blank the columns.
        import inspect
        src = inspect.getsource(run_pipeline)
        for key in ("stubs", "nigerian", "fresh", "distinct"):
            assert f'last_collect_stats.get("{key}"' in src
        for col in ("Stubs", "Nigerian", "Fresh", "Distinct"):
            assert col in SHEETS_CONFIG["Daily Reports"]
