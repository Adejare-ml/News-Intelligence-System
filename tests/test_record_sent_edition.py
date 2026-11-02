"""The "since last email" marker moves only after a send that went out."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import record_sent_edition as rec  # noqa: E402

import run_pipeline as rp  # noqa: E402
from backend.app.services import email_digest as ed  # noqa: E402

DIGEST = {"edition": "20261103-120", "through_id": 120, "built_at": "2026-11-03 07:05:00", "psc_keys": ["a|b|u"]}
SENT = {"day": "2026-11-03", "edition": "20261103-120", "recipients": 3, "sent": 3, "failed": 0}


def test_a_delivered_send_moves_the_marker(tmp_path):
    ok, why = rec.record(SENT, DIGEST, str(tmp_path))
    assert ok, why
    marker = json.loads((tmp_path / "digests" / "last_edition.json").read_text())
    assert marker["through_id"] == 120 and marker["psc_keys"] == ["a|b|u"] and marker["sent_day"] == "2026-11-03"
    assert (tmp_path / "digests" / "20261103-120.json").exists()


def test_no_subscribers_still_moves_the_marker(tmp_path):
    assert rec.record(dict(SENT, recipients=0, sent=0), DIGEST, str(tmp_path))[0]


def test_a_partial_send_still_moves_the_marker(tmp_path):
    result = dict(SENT, sent=450, failed=12, error="Gmail daily cap: 12 not sent")
    assert rec.record(result, DIGEST, str(tmp_path))[0]


@pytest.mark.parametrize("result", [
    {"skipped": "edition_already_sent", "edition": "20261103-120"},
    {"skipped": "already_sent_today", "day": "2026-11-03", "edition": "20261103-120"},
])
def test_this_edition_sent_earlier_is_recorded_on_a_retry(tmp_path, result):
    assert rec.record(result, DIGEST, str(tmp_path))[0]


@pytest.mark.parametrize("result", [
    dict(SENT, sent=0, failed=3),                                    # every copy failed
    {"skipped": "already_sent_today", "day": "2026-11-03", "edition": "20261102-90"},
    {"skipped": "send_in_progress_or_incomplete", "day": "2026-11-03", "edition": "20261103-120"},
    {"test": True, "edition": "20261103-120", "sent": 1, "failed": 0},
    {"dry_run": True, "edition": "20261103-120", "recipients": 3},
    dict(SENT, edition="20261103-121-preview"),                      # not the digest in hand
    {"error": "Email provider is not configured."},
])
def test_anything_else_leaves_the_marker(tmp_path, result):
    ok, _ = rec.record(result, DIGEST, str(tmp_path))
    assert not ok and not (tmp_path / "digests").exists()


def _articles(time=None):
    # Relative to now: write_email_digest builds at the real clock.
    time = time or (ed.datetime.utcnow() - ed.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return [{"ID": 50 + i, "Time": time, "Title": t, "Source": "The Punch",
             "URL": f"https://punchng.com/{i}", "Summary": t + ".", "Risk Level": "Low", "Risk Score": 20}
            for i, t in enumerate(["MTN raises data tariffs", "Seplat signs gas supply deal"])]


@pytest.mark.parametrize("edition_run", [False, True])
def test_no_build_moves_the_marker(tmp_path, monkeypatch, edition_run):
    monkeypatch.setattr(rp, "DATA_DIR", str(tmp_path))
    monkeypatch.setenv("EMAIL_EDITION", "1" if edition_run else "")
    # As on the scheduler, with the Sheets database reachable.
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setattr(rp.db, "use_local", False, raising=False)
    monkeypatch.setattr(rp.LLMService, "generate_digest", staticmethod(lambda prompt: ("{}", "gemini")))
    (tmp_path / "digests").mkdir()
    marker = {"edition": "20261101-40", "through_id": 40, "built_at": "2026-11-01 07:05:00", "psc_keys": []}
    (tmp_path / "digests" / "last_edition.json").write_text(json.dumps(marker))

    rp.write_email_digest(_articles(), [])

    built = json.loads((tmp_path / "email_digest.json").read_text())
    assert built["edition"].endswith("-preview") is (not edition_run)
    assert built["stats"]["reports"] == 2 and built["since"].startswith("Sun 1 Nov")
    assert ("gemini" == built["engines"]["digest"]) is edition_run
    assert json.loads((tmp_path / "digests" / "last_edition.json").read_text()) == marker
    assert sorted(os.listdir(tmp_path / "digests")) == ["last_edition.json"]


def test_a_failed_send_leaves_its_stories_for_the_next_email(tmp_path):
    rows = _articles("2026-11-02T06:00:00Z")
    first = ed.build_edition(rows[:1], [], ed.datetime(2026, 11, 2, 7, 5), {"through_id": 40, "built_at": "2026-11-01 07:05:00"})
    assert not rec.record(dict(SENT, edition=first["edition"], sent=0, failed=2), first, str(tmp_path))[0]
    nxt = ed.build_edition(rows, [], ed.datetime(2026, 11, 3, 7, 5), {"through_id": 40, "built_at": "2026-11-01 07:05:00"})
    assert {c["headline"] for c in nxt["cards"]} == {"MTN raises data tariffs", "Seplat signs gas supply deal"}


def test_a_run_on_the_local_fallback_builds_a_preview(tmp_path, monkeypatch):
    monkeypatch.setattr(rp, "DATA_DIR", str(tmp_path))
    monkeypatch.setenv("EMAIL_EDITION", "1")
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setattr(rp.db, "use_local", True, raising=False)
    monkeypatch.setattr(rp.LLMService, "generate_digest", staticmethod(lambda prompt: ("{}", "gemini")))
    rp.write_email_digest(_articles(), [])
    built = json.loads((tmp_path / "email_digest.json").read_text())
    assert built["edition"].endswith("-preview") and built["engines"]["digest"] == ""
