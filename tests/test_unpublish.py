"""scripts/unpublish.py: the owner's one command to take a name off the site."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import unpublish  # noqa: E402

from backend.app.services import suppression  # noqa: E402


def test_adds_a_name_with_its_reason_and_date(tmp_path):
    msg = unpublish.main(["Tolu Bakare", "--reason", "dispute upheld", "--kind", "person",
                          "--data-dir", str(tmp_path), "--today", "2026-11-07"])
    assert "Tolu Bakare" in msg
    entries = json.loads((tmp_path / "suppressed.json").read_text())
    assert entries == [{"name": "Tolu Bakare", "kind": "person", "added": "2026-11-07", "reason": "dispute upheld"}]
    # The export reads the same file.
    assert suppression.load(str(tmp_path)) == ["Tolu Bakare"]


def test_appends_and_never_adds_the_same_name_twice(tmp_path):
    unpublish.main(["Ikeja Mills", "--data-dir", str(tmp_path), "--today", "2026-11-01"])
    unpublish.main(["Tolu Bakare", "--data-dir", str(tmp_path), "--today", "2026-11-02"])
    msg = unpublish.main(["  ikeja   MILLS ", "--data-dir", str(tmp_path), "--today", "2026-11-03"])
    assert "already" in msg
    entries = json.loads((tmp_path / "suppressed.json").read_text())
    assert [e["name"] for e in entries] == ["Ikeja Mills", "Tolu Bakare"]
    assert entries[0] == {"name": "Ikeja Mills", "added": "2026-11-01", "reason": ""}


def test_refuses_names_too_short_to_match_safely(tmp_path):
    msg = unpublish.main(["AB", "--data-dir", str(tmp_path)])
    assert "too short" in msg
    assert not (tmp_path / "suppressed.json").exists()
