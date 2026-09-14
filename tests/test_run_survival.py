"""Run-survival fixes (Package 15).

Each test pins one failure mode where a transient error or malformed
value used to cost far more than itself: a Sheets read error that
silently became "the database is empty", a blank Mention Count cell that
aborted the whole batch, a scalar list element from a fallback model, a
Filtered reject fed back into the day's brief.
"""

import pytest

from backend.app.db.excel_db import SheetsDatabase, _lenient_int
from backend.app.services.llm import LLMService
from run_pipeline import published_today


class TestReadSheetRaises:
    def test_remote_read_failure_raises_instead_of_returning_empty(self, monkeypatch):
        """A 429/503 on the read must surface, not masquerade as an empty
        sheet -- proceeding blind re-spent the batch's whole LLM quota and
        minted duplicate rows with colliding IDs."""
        monkeypatch.setattr("time.sleep", lambda s: None)  # retry backoff

        db = SheetsDatabase.__new__(SheetsDatabase)
        db.use_local = False
        db._cache = {}
        import threading
        db._lock = threading.RLock()

        class ExplodingSpreadsheet:
            def worksheet(self, name):
                raise ConnectionError("quota exceeded")
        db.spreadsheet = ExplodingSpreadsheet()

        with pytest.raises(ConnectionError):
            db._read_sheet("Articles")
        assert "Articles" not in db._cache, "a failed read must not poison the cache"

    def test_remote_read_retries_transient_failures(self, monkeypatch):
        monkeypatch.setattr("time.sleep", lambda s: None)

        db = SheetsDatabase.__new__(SheetsDatabase)
        db.use_local = False
        db._cache = {}
        import threading
        db._lock = threading.RLock()

        attempts = {"n": 0}

        class FlakyWorksheet:
            def get_all_records(self):
                return [{"URL": "https://p.test/a"}]

        class FlakySpreadsheet:
            def worksheet(self, name):
                attempts["n"] += 1
                if attempts["n"] < 3:
                    raise ConnectionError("transient")
                return FlakyWorksheet()
        db.spreadsheet = FlakySpreadsheet()

        rows = db._read_sheet("Articles")
        assert rows == [{"URL": "https://p.test/a"}]
        assert attempts["n"] == 3


class TestLenientInt:
    def test_blank_and_garbage_fall_back(self):
        assert _lenient_int("", default=1) == 1
        assert _lenient_int(None, default=1) == 1
        assert _lenient_int("n/a", default=1) == 1

    def test_real_values_parse(self):
        assert _lenient_int(4) == 4
        assert _lenient_int("4") == 4
        assert _lenient_int(4.0) == 4
        assert _lenient_int(" 12 ") == 12


class TestValidatorHardening:
    def test_scalar_list_elements_are_dropped(self):
        out = LLMService._validate_llm_output({
            "relevant": True,
            "organizations": ["NNPC", {"name": "CBN", "type": "agency"}, 7],
            "people": [None, {"name": "Ada Obi"}],
            "significant_control": ["junk"],
        })
        assert out["organizations"] == [{"name": "CBN", "type": "agency"}]
        assert out["people"] == [{"name": "Ada Obi"}]
        assert out["significant_control"] == []

    def test_risk_score_coerces_strings_and_percents(self):
        assert LLMService._validate_llm_output({"risk_score": "85%"})["risk_score"] == 85
        assert LLMService._validate_llm_output({"risk_score": "72.4"})["risk_score"] == 72
        assert LLMService._validate_llm_output({"risk_score": "high"})["risk_score"] == 10
        assert LLMService._validate_llm_output({})["risk_score"] == 10

    def test_importance_score_same_treatment(self):
        assert LLMService._validate_llm_output({"importance_score": "90"})["importance_score"] == 90
        assert LLMService._validate_llm_output({"importance_score": "n/a"})["importance_score"] == 50


class TestPublishedTodaySkipsFiltered:
    def test_filtered_rows_do_not_reach_the_brief(self):
        from datetime import datetime
        stamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        rows = [
            {"Title": "Real story", "Time": stamp, "Status": "Unread",
             "Risk Score": 80, "Summary": "s", "Category": "Company"},
            {"Title": "Sports reject", "Time": stamp, "Status": "Filtered",
             "Risk Score": 0, "Summary": "Sports reject", "Category": "Non-Relevant"},
            {"Title": "filtered lowercase", "Time": stamp, "Status": " filtered ",
             "Risk Score": 0, "Summary": "x", "Category": "Non-Relevant"},
        ]
        titles = [r["title"] for r in published_today(rows)]
        assert titles == ["Real story"]
