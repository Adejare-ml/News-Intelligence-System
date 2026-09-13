"""
Regression tests for the bug-fix pack: writes that fail must say so, LLM
JSON must survive the prose models wrap it in, and the Celery entity path
must apply the same publication guard as the Sheets pipeline.

Each class pins one verified finding:

* add_article returned True after _append_row swallowed a write error, and
  the pre-write cache update made the phantom row visible to later reads
  in the same process -- so a failed write was never retried.
* _extract_json_block regex-stripped markdown fences and then grabbed
  greedily; any trailing prose after the closing fence ("Let me know if
  you need anything else!") poisoned the parse and dropped the article.
* tasks.py resolved every NER organization into the entity directory,
  including the reporting outlet -- "Reuters" became a company every 30
  minutes via the Celery path.
"""
import os

import pytest

from backend.app.db.excel_db import SheetsDatabase
from backend.app.services.llm import LLMService
from backend.app.services.relevance import organization_candidates

TEST_DB_PATH = "tests/test_bugfix_pack.xlsx"


@pytest.fixture
def db():
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)
    d = SheetsDatabase()
    d.use_local = True
    d.local_path = TEST_DB_PATH
    d._cache = {}
    d._init_db()
    yield d
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)


ARTICLE = {
    "Time": "2026-08-20T10:00:00",
    "Title": "Dangote Cement announces board change",
    "Source": "Punch",
    "URL": "https://punchng.com/board-change",
    "Category": "Company",
    "Risk Score": 40,
    "Summary": "s",
    "Status": "Unread",
}


class TestWriteFailurePropagation:
    def test_append_row_reports_success(self, db):
        assert db._append_row("Articles", dict(ARTICLE, ID=1)) is True

    def test_add_article_returns_false_when_the_write_fails(self, db, monkeypatch):
        import backend.app.db.excel_db as mod

        def broken_writer(*args, **kwargs):
            raise OSError("disk full")

        monkeypatch.setattr(mod.pd, "ExcelWriter", broken_writer)
        assert db.add_article(dict(ARTICLE)) is False

    def test_a_failed_write_leaves_no_phantom_row(self, db, monkeypatch):
        """The cache used to be updated before the write, so the phantom
        row passed later dedup checks and the article was lost for good."""
        import backend.app.db.excel_db as mod
        real_writer = mod.pd.ExcelWriter

        def broken_writer(*args, **kwargs):
            raise OSError("disk full")

        monkeypatch.setattr(mod.pd, "ExcelWriter", broken_writer)
        assert db.add_article(dict(ARTICLE)) is False
        assert all(r.get("URL") != ARTICLE["URL"] for r in db.get_articles())

        # Storage recovers -> the same URL must now be addable (retryable),
        # not skipped as a duplicate of its own failed write.
        monkeypatch.setattr(mod.pd, "ExcelWriter", real_writer)
        assert db.add_article(dict(ARTICLE)) is True
        db._cache = {}
        assert any(r.get("URL") == ARTICLE["URL"] for r in db.get_articles())


class TestJsonExtraction:
    def test_clean_fenced_block(self):
        text = '```json\n{"relevant": true, "summary": "x"}\n```'
        assert LLMService._extract_json_block(text)["relevant"] is True

    def test_prose_after_the_closing_fence(self):
        """The verified failure: trailing chat after fenced output."""
        text = ('Here is the analysis:\n```json\n{"relevant": true}\n```\n'
                "Let me know if you need anything else!")
        assert LLMService._extract_json_block(text) == {"relevant": True}

    def test_unfenced_json_with_surrounding_prose(self):
        text = 'Sure! The result is {"risk_score": 70} as requested.'
        assert LLMService._extract_json_block(text) == {"risk_score": 70}

    def test_nested_objects(self):
        text = 'Output: {"a": {"b": {"c": 1}}, "d": 2} -- done.'
        assert LLMService._extract_json_block(text) == {"a": {"b": {"c": 1}}, "d": 2}

    def test_braces_inside_string_values_do_not_truncate(self):
        text = '{"summary": "budget {revised} for } 2026", "ok": true}'
        parsed = LLMService._extract_json_block(text)
        assert parsed["summary"] == "budget {revised} for } 2026"

    def test_escaped_quotes_inside_strings(self):
        text = 'Answer: {"summary": "the \\"main\\" point"} thanks'
        assert LLMService._extract_json_block(text)["summary"] == 'the "main" point'

    def test_no_json_returns_none(self):
        assert LLMService._extract_json_block("no structured output here") is None
        assert LLMService._extract_json_block("") is None
        assert LLMService._extract_json_block("{never closed") is None


class TestOrganizationCandidates:
    def test_publications_are_filtered_out(self):
        names = ["Reuters", "Dangote Cement Plc", "Punch Newspapers", "BBC News"]
        kept = [n for n, _ in organization_candidates(names)]
        assert kept == ["Dangote Cement Plc"]

    def test_agency_vs_company_classification(self):
        pairs = dict(organization_candidates([
            "Securities and Exchange Commission",
            "Federal Ministry of Finance",
            "Access Holdings Plc",
        ]))
        assert pairs["Securities and Exchange Commission"] == "agency"
        assert pairs["Federal Ministry of Finance"] == "agency"
        assert pairs["Access Holdings Plc"] == "company"

    def test_empty_input(self):
        assert organization_candidates([]) == []
        assert organization_candidates(None) == []
