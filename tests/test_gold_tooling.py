"""
The gold set is what GEPA optimises toward, so errors in it propagate into the
prompt. These tests cover the two guards that matter:

  * an uncorrected draft can never reach the optimiser, and
  * a label that breaks the rules the metric enforces is caught before it does.

All offline: no network, no keys, no models.
"""
import json
import os
import subprocess
import sys

import pytest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def write_jsonl(path, records):
    with open(path, "w", encoding="utf-8") as fh:
        for record in records:
            fh.write(json.dumps(record) + "\n")
    return str(path)


ARTICLE = (
    "Femi Otedola has increased his shareholding in First HoldCo, according to a "
    "filing seen on Monday by reporters. The transaction was disclosed to the "
    "exchange in a statement that confirmed the size of the stake and the parties "
    "involved in the transfer of the shares."
)


def good_record(**over):
    record = {
        "title": "Otedola increases stake in First HoldCo",
        "article_text": ARTICLE,
        "url": "https://example.test/1",
        "relevant": True,
        "category": "Company",
        "event_type": "Ownership Change",
        "risk_score": 70,
        "risk_level": "High",
        "importance_score": 75,
        "summary": "Otedola raised his holding.",
        "organizations": [{"name": "First HoldCo", "type": "company"}],
        "people": [],
        "significant_control": [{"name": "Femi Otedola", "organization": "First HoldCo"}],
        "procurement": None,
        "verified_by": "adejare",
    }
    record.update(over)
    return record


def run(script, *args):
    return subprocess.run(
        [sys.executable, os.path.join(REPO, "scripts", script), *args],
        capture_output=True, text=True, cwd=REPO,
    )


# --- the guard that matters most --------------------------------------------

class TestVerifiedGate:
    """Uncorrected drafts must be structurally unable to reach GEPA."""

    def load(self, path):
        sys.path.insert(0, os.path.join(REPO, "scripts"))
        import importlib
        module = importlib.import_module("optimise_extraction")
        importlib.reload(module)
        return module.load_gold(path)

    def test_unverified_drafts_are_skipped(self, tmp_path):
        path = write_jsonl(tmp_path / "gold.jsonl", [
            good_record(verified_by=None),
            good_record(verified_by=""),
            good_record(verified_by="   "),
            good_record(verified_by="adejare"),
        ])
        examples, skipped = self.load(path)
        assert len(examples) == 1
        assert skipped == 3

    def test_a_file_of_only_drafts_yields_nothing(self, tmp_path):
        """12 drafts must not look like 12 examples."""
        path = write_jsonl(tmp_path / "gold.jsonl",
                           [good_record(verified_by=None) for _ in range(12)])
        examples, skipped = self.load(path)
        assert examples == []
        assert skipped == 12

    def test_archive_hints_never_reach_the_example(self, tmp_path):
        path = write_jsonl(tmp_path / "gold.jsonl", [
            good_record(_archive_hint={"category": "Government", "note": "hint"}),
        ])
        examples, _ = self.load(path)
        assert not hasattr(examples[0], "_archive_hint")
        assert examples[0].category == "Company"


# --- drafting ----------------------------------------------------------------

class TestDraftGold:
    def test_drafts_are_blank_and_unverified(self, tmp_path):
        corpus_dir = tmp_path / "corpus"
        corpus_dir.mkdir()
        write_jsonl(corpus_dir / "a.jsonl", [
            {"title": "T1", "article_text": ARTICLE, "url": "https://example.test/1",
             "source": "Punch"},
        ])
        gold = tmp_path / "gold.jsonl"
        result = run("draft_gold.py", "--corpus", str(corpus_dir / "*.jsonl"),
                     "--gold", str(gold), "--archive", "/nonexistent.json")
        assert result.returncode == 0, result.stderr

        record = json.loads(gold.read_text().strip())
        assert record["verified_by"] is None
        assert record["article_text"] == ARTICLE
        # Every answer field present, and empty.
        assert record["relevant"] is None
        assert record["category"] is None
        assert record["organizations"] == []
        assert record["significant_control"] == []

    def test_rerunning_does_not_duplicate_or_disturb_existing(self, tmp_path):
        corpus_dir = tmp_path / "corpus"
        corpus_dir.mkdir()
        write_jsonl(corpus_dir / "a.jsonl", [
            {"title": "T1", "article_text": ARTICLE, "url": "https://example.test/1"},
        ])
        gold = tmp_path / "gold.jsonl"
        # A verified record for the same URL is already present.
        write_jsonl(gold, [good_record(url="https://example.test/1")])

        result = run("draft_gold.py", "--corpus", str(corpus_dir / "*.jsonl"),
                     "--gold", str(gold), "--archive", "/nonexistent.json")
        assert result.returncode == 0, result.stderr

        lines = [json.loads(l) for l in gold.read_text().splitlines() if l.strip()]
        assert len(lines) == 1
        assert lines[0]["verified_by"] == "adejare"

    def test_refuses_when_the_corpus_is_empty(self, tmp_path):
        result = run("draft_gold.py", "--corpus", str(tmp_path / "none" / "*.jsonl"),
                     "--gold", str(tmp_path / "gold.jsonl"))
        assert result.returncode != 0
        assert "No corpus records" in (result.stdout + result.stderr)


# --- validation --------------------------------------------------------------

class TestValidateGold:
    def validate(self, tmp_path, records):
        path = write_jsonl(tmp_path / "gold.jsonl", records)
        return run("validate_gold.py", "--gold", path)

    def test_a_correct_record_passes(self, tmp_path):
        result = self.validate(tmp_path, [good_record()])
        assert result.returncode == 0, result.stdout
        assert "no problems found" in result.stdout

    def test_percentage_absent_from_the_article_is_rejected(self, tmp_path):
        """A label may not assert a figure the article never stated."""
        result = self.validate(tmp_path, [good_record(significant_control=[
            {"name": "Femi Otedola", "organization": "First HoldCo", "percentage": "31%"}
        ])])
        assert result.returncode == 1
        assert "does not appear in article_text" in result.stdout

    def test_percentage_present_in_the_article_is_accepted(self, tmp_path):
        text = ARTICLE + " The holding now stands at 31%."
        result = self.validate(tmp_path, [good_record(
            article_text=text,
            significant_control=[{"name": "Femi Otedola", "organization": "First HoldCo",
                                  "percentage": "31%"}])])
        assert result.returncode == 0, result.stdout

    def test_publication_listed_as_organization_is_rejected(self, tmp_path):
        result = self.validate(tmp_path, [good_record(organizations=[
            {"name": "Premium Times", "type": "company"}])])
        assert result.returncode == 1
        assert "publication or page furniture" in result.stdout

    def test_psc_holder_duplicated_into_people_is_rejected(self, tmp_path):
        result = self.validate(tmp_path, [good_record(people=[
            {"name": "Femi Otedola", "organization": "First HoldCo",
             "position": "Investor", "event": "other"}])])
        assert result.returncode == 1
        assert "belongs only in the latter" in result.stdout

    def test_off_topic_marked_relevant_is_rejected(self, tmp_path):
        result = self.validate(tmp_path, [good_record(
            title="Super Eagles beat Ghana 2-1 in Lagos", relevant=True)])
        assert result.returncode == 1
        assert "sport" in result.stdout

    def test_truncated_article_is_flagged_as_a_failed_fetch(self, tmp_path):
        result = self.validate(tmp_path, [good_record(article_text="Too short.")])
        assert result.returncode == 1
        assert "likely a failed fetch" in result.stdout

    def test_bad_enum_on_a_verified_record_is_rejected(self, tmp_path):
        result = self.validate(tmp_path, [good_record(category="Sports")])
        assert result.returncode == 1
        assert "is not one of" in result.stdout

    def test_blank_enums_are_fine_on_an_unverified_draft(self, tmp_path):
        """Drafts are legitimately empty; only verified records must be complete."""
        draft = good_record(verified_by=None, category=None, relevant=None,
                            organizations=[], significant_control=[])
        result = self.validate(tmp_path, [draft])
        assert result.returncode == 0, result.stdout

    def test_null_relevant_on_a_verified_record_is_rejected(self, tmp_path):
        result = self.validate(tmp_path, [good_record(relevant=None)])
        assert result.returncode == 1
        assert "cannot be left blank" in result.stdout

    def test_require_verified_threshold(self, tmp_path):
        path = write_jsonl(tmp_path / "gold.jsonl", [good_record(verified_by=None)])
        result = run("validate_gold.py", "--gold", path, "--require-verified", "10")
        assert result.returncode == 1
        assert "Only 0 verified" in result.stdout

    def test_invalid_json_names_the_line(self, tmp_path):
        path = tmp_path / "gold.jsonl"
        path.write_text(json.dumps(good_record()) + "\nnot json\n")
        result = run("validate_gold.py", "--gold", str(path))
        assert result.returncode == 1
        assert ":2: invalid JSON" in result.stdout
