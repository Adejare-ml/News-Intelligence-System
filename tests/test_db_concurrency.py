"""
The shared database object must survive concurrent writers, and a model
response that never answered the relevance question must not publish.

Both were found by a full-repo review and verified before fixing:

* SheetsDatabase is one shared instance used by every FastAPI request
  (sync handlers run in Starlette's threadpool) and by the pipeline. The
  local-Excel write path is read-whole-sheet -> concat -> rewrite-whole-
  workbook with, previously, no lock anywhere in the repo: two concurrent
  writers each read the same file, each appended their own row, and
  whichever rewrite finished last silently erased the other's. No error,
  no log, just a missing row.

* _validate_llm_output back-filled a missing "relevant" key to True. Every
  cascade branch routes its JSON through that validator before
  run_pipeline sees it, so run_pipeline's own fail-closed default
  (`.get("relevant", False)`, added with a comment explaining exactly this
  bug) was dead code -- the key always existed by then, and a truncated
  model response still published as relevant.
"""
import os
import threading

import pytest

from backend.app.db.excel_db import SheetsDatabase
from backend.app.services.llm import LLMService

TEST_DB_PATH = "tests/test_db_concurrency.xlsx"


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


class TestConcurrentWrites:
    def test_concurrent_appends_lose_no_rows(self, db):
        """
        The lost-update case: N threads each append distinct rows; every
        row must survive into the workbook. Before the lock, interleaved
        read->rewrite cycles dropped whichever writes lost the race.
        """
        threads_n, rows_per_thread = 4, 3

        def writer(t):
            for i in range(rows_per_thread):
                db._append_row("People", {
                    "Name": f"Person t{t} r{i}",
                    "Position": "Director",
                    "Organization": "Test Org",
                    "Event": "appointment",
                    "Date": "2026-08-16",
                })

        threads = [threading.Thread(target=writer, args=(t,)) for t in range(threads_n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Read from disk, not the cache: the cache is maintained on append
        # and would mask a row lost from the file itself.
        db._cache = {}
        names = {r["Name"] for r in db.get_people()}
        expected = {f"Person t{t} r{i}" for t in range(threads_n) for i in range(rows_per_thread)}
        assert names == expected, f"lost rows: {sorted(expected - names)}"

    def test_concurrent_add_article_mints_unique_ids(self, db):
        """
        add_article's dedup -> next-ID -> append sequence must be atomic:
        two calls interleaving between the max(ID) computation and the
        append would both mint the same ID.
        """
        def writer(t):
            db.add_article({
                "Title": f"Article {t}",
                "URL": f"https://example.test/{t}",
                "Source": "Test",
                "Category": "Company",
                "Risk Score": 10,
                "Summary": "s",
            })

        threads = [threading.Thread(target=writer, args=(t,)) for t in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        db._cache = {}
        ids = [r["ID"] for r in db.get_articles()]
        assert len(ids) == 6
        assert len(set(ids)) == 6, f"duplicate IDs minted: {sorted(ids)}"


class TestFloatTypedIds:
    """
    pandas upcasts an integer column to float64 the moment any cell in it
    is blank, after which every ID reads back as e.g. 5.0 -- and
    str(5.0).isdigit() is False, which was the old filter. All existing
    IDs silently failed it and the auto-increment restarted at 1.
    """

    def test_as_int_id_accepts_int_str_and_float_forms(self):
        for value in (5, "5", 5.0, "5.0", " 5 "):
            assert SheetsDatabase._as_int_id(value) == 5, repr(value)

    def test_as_int_id_rejects_non_ids(self):
        for value in (None, "", "abc", "5.5", float("nan")):
            assert SheetsDatabase._as_int_id(value) == 0, repr(value)

    def test_next_id_continues_after_float_upcast(self, db):
        # Simulate what a re-read of a float64 ID column hands back.
        db._cache["Articles"] = [
            {"ID": 5.0, "URL": "https://example.test/old-a"},
            {"ID": 7.0, "URL": "https://example.test/old-b"},
        ]
        db.add_article({
            "Title": "New",
            "URL": "https://example.test/new",
            "Source": "Test",
            "Category": "Company",
            "Risk Score": 10,
            "Summary": "s",
        })
        new_row = [r for r in db._cache["Articles"] if r["URL"].endswith("/new")][0]
        assert new_row["ID"] == 8, f"expected 8, got {new_row['ID']} (counter reset)"


class TestRelevantFailsClosed:
    def test_missing_relevant_key_defaults_to_false(self):
        """
        A model that did not answer the relevance question has not answered
        it. The validator is the layer that actually decides this: every
        cascade branch routes through it before run_pipeline's own check.
        """
        out = LLMService._validate_llm_output({"summary": "truncated response"})
        assert out["relevant"] is False

    def test_explicit_relevant_true_is_preserved(self):
        out = LLMService._validate_llm_output({"relevant": True, "summary": "s"})
        assert out["relevant"] is True

    def test_explicit_relevant_false_is_preserved(self):
        out = LLMService._validate_llm_output({"relevant": False})
        assert out["relevant"] is False
