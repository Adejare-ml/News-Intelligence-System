"""
Ownership Finding of the Week: the drafting script turns the owner's pick into
share-ready text built only from what the site already publishes.

The guard that matters most: nothing the register gate withholds (no source
link, or quarantined) can reach a draft, and a person is never named without a
published register row behind them. All offline, fixtures only.
"""
import json
import os
import subprocess
import sys

import pytest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(REPO, "scripts"))

import draft_finding  # noqa: E402

SITE = "https://auranews.pages.dev"

REGISTER = [
    {
        "Person Name": "Tony Elumelu", "Company": "Seplat", "Percentage": "",
        "Nature of Control": "Ownership of shares", "Board Role": "", "Kind": "stake",
        "Date": "2026-08-21", "Source URL": "https://punchng.com/elumelu-seplat/",
        "Source Title": "Elumelu's Seplat investment doubles", "Publisher": "The Punch",
        "Quarantined": False,
    },
    {
        "Person Name": "Tony O. Elumelu", "Company": "United Bank for Africa (UBA) Plc",
        "Percentage": "24.5%", "Nature of Control": "Indirect ownership via Heirs Holdings Limited",
        "Board Role": "", "Kind": "stake", "Person Key": "tony elumelu",
        "Company Key": "united bank for africa",
        "Date": "2026-06-18", "Source URL": "https://punchng.com/uba-chairman/",
        "Source Title": "UBA welcomes new chairman", "Publisher": "The Punch",
        "Quarantined": False,
    },
    # Withheld: no source link.
    {
        "Person Name": "Zed Unsourced", "Company": "Seplat", "Percentage": "61.5%",
        "Nature of Control": "Ownership of shares", "Date": "2026-10-20",
        "Source": "", "Source URL": "",
    },
    # Withheld: quarantined by the gate.
    {
        "Person Name": "Quin Quarantined", "Company": "Quarantined Ltd", "Percentage": "",
        "Nature of Control": "Significant influence", "Date": "2026-10-20",
        "Source URL": "https://example.test/q", "Quarantined": True,
    },
]

ARTICLES = [
    {
        "Time": "2026-11-02T08:00:00Z", "Title": "Seplat output rises in third quarter",
        "Source": "BusinessDay", "URL": "https://businessday.ng/seplat-output/",
        "Entities": "Seplat|NUPRC",
    },
    {
        "Time": "2026-11-03T08:00:00Z", "Title": "Zed Unsourced eyes bigger Seplat role",
        "Source": "Vanguard", "URL": "https://vanguardngr.com/zed/",
        "Entities": "Seplat|Zed Unsourced",
    },
    {
        "Time": "2026-11-01T08:00:00Z", "Title": "UBA posts N1trn half-year profit",
        "Source": "Nairametrics", "URL": "https://nairametrics.com/uba-profit/",
        "Entities": "United Bank for Africa",
    },
    {
        "Time": "2026-11-04T08:00:00Z", "Title": "Dangote refinery ships first cargo",
        "Source": "The Punch", "URL": "https://punchng.com/dangote-cargo/",
        "Entities": "Dangote Petroleum Refinery",
    },
]

PEOPLE = [{"Name": "Ada Appointee", "Position": "CEO", "Organization": "Dangote Petroleum Refinery"}]


def make_data(tmp_path, picks, register=REGISTER, articles=ARTICLES, people=PEOPLE):
    data = tmp_path / "data"
    (data / "findings").mkdir(parents=True)
    (data / "significant_control.json").write_text(json.dumps(register))
    (data / "latest.json").write_text(json.dumps(articles))
    (data / "people.json").write_text(json.dumps(people))
    (data / "findings" / "picks.json").write_text(json.dumps(picks))
    return data


def run(data):
    return subprocess.run(
        [sys.executable, os.path.join(REPO, "scripts", "draft_finding.py"), "--data-dir", str(data)],
        capture_output=True, text=True,
    )


ENTITY_PICK = {"week": "2026-W45", "entity": "seplat",
               "headline": "Who is behind Seplat?", "note": "Two outlets, one holder."}


def test_slugify_matches_the_site():
    assert draft_finding.slugify("First HoldCo Plc.") == "first-holdco-plc"
    assert draft_finding.slugify("Procter & Gamble") == "procter-and-gamble"
    assert draft_finding.slugify("Société Générale") == "societe-generale"


def test_latest_pick_is_the_newest_week():
    picks = [dict(ENTITY_PICK, week="2026-W44"), ENTITY_PICK, dict(ENTITY_PICK, week="2026-W09")]
    assert draft_finding.latest_pick(picks)["week"] == "2026-W45"


def test_latest_pick_rejects_a_bad_week():
    with pytest.raises(draft_finding.Refusal, match="YYYY-Www"):
        draft_finding.latest_pick([dict(ENTITY_PICK, week="2026-45")])


def test_entity_finding_uses_only_published_facts(tmp_path):
    data = make_data(tmp_path, [ENTITY_PICK])
    result = run(data)
    assert result.returncode == 0, result.stderr
    finding = json.loads((data / "findings" / "2026-W45.json").read_text())

    assert finding["week"] == "2026-W45"
    assert finding["headline"] == "Who is behind Seplat?"
    assert 2 <= len(finding["bullets"]) <= 3
    for b in finding["bullets"]:
        assert b["outlet"] and b["url"].startswith("https://") and b["date"]
    text = json.dumps(finding)
    # Withheld register rows, and news naming them, never reach a draft.
    assert "Zed Unsourced" not in text
    assert "61.5%" not in text
    assert "https://punchng.com/elumelu-seplat/" in text
    assert "https://businessday.ng/seplat-output/" in text
    # A register row names a person, so the page stays out of search.
    assert finding["names_person"] is True


def test_drafts_fit_their_platforms_and_end_with_the_link(tmp_path):
    long_pick = dict(ENTITY_PICK, headline="Seplat " * 80, note="n " * 600)
    data = make_data(tmp_path, [long_pick])
    assert run(data).returncode == 0
    finding = json.loads((data / "findings" / "2026-W45.json").read_text())
    link = f"{SITE}/findings/2026-W45/"
    drafts = finding["drafts"]
    assert finding["link"] == link
    assert len(drafts["linkedin"]) <= 1300
    assert len(drafts["x"]) <= 280
    for text in (drafts["linkedin"], drafts["x"], drafts["email"]["body"]):
        assert text.endswith(link)
    assert drafts["email"]["subject"]


def test_drafting_is_deterministic(tmp_path):
    data = make_data(tmp_path, [ENTITY_PICK])
    run(data)
    first = (data / "findings" / "2026-W45.json").read_text()
    run(data)
    assert (data / "findings" / "2026-W45.json").read_text() == first


def test_record_ref_finds_the_holding_across_spellings(tmp_path):
    pick = {"week": "2026-W46", "record_ref": "tony-elumelu/united-bank-for-africa-uba-plc",
            "headline": "Elumelu and UBA", "note": ""}
    data = make_data(tmp_path, [pick])
    result = run(data)
    assert result.returncode == 0, result.stderr
    finding = json.loads((data / "findings" / "2026-W46.json").read_text())
    assert any("24.5%" in b["text"] for b in finding["bullets"])


def test_refuses_a_record_the_gate_withholds(tmp_path):
    pick = {"week": "2026-W45", "record_ref": "zed-unsourced/seplat", "headline": "x", "note": ""}
    data = make_data(tmp_path, [pick])
    result = run(data)
    assert result.returncode == 1
    assert "not in the published exports" in result.stderr
    assert not (data / "findings" / "2026-W45.json").exists()


def test_refuses_a_quarantined_entity(tmp_path):
    pick = {"week": "2026-W45", "entity": "quin-quarantined", "headline": "x", "note": ""}
    result = run(make_data(tmp_path, [pick]))
    assert result.returncode == 1
    assert "not in the published exports" in result.stderr


def test_refuses_to_name_a_person_without_register_evidence(tmp_path):
    # Ada appears only in people.json (appointments), never in a published register row.
    pick = {"week": "2026-W45", "entity": "ada-appointee", "headline": "x", "note": ""}
    result = run(make_data(tmp_path, [pick]))
    assert result.returncode == 1
    assert "register" in result.stderr


def test_refuses_a_headline_naming_an_unbacked_person(tmp_path):
    pick = dict(ENTITY_PICK, headline="Zed Unsourced and Seplat")
    result = run(make_data(tmp_path, [pick]))
    assert result.returncode == 1
    assert "Zed Unsourced" in result.stderr


def test_refuses_when_too_few_published_facts(tmp_path):
    pick = {"week": "2026-W45", "entity": "nowhere-ltd", "headline": "x", "note": ""}
    result = run(make_data(tmp_path, [pick]))
    assert result.returncode == 1
    assert "not in the published exports" in result.stderr


def test_company_with_only_news_does_not_name_a_person(tmp_path):
    extra = dict(ARTICLES[-1], URL="https://punchng.com/dangote-2/", Time="2026-11-05T08:00:00Z",
                 Title="Dangote refinery cuts petrol price")
    pick = {"week": "2026-W45", "entity": "dangote-petroleum-refinery", "headline": "Refinery week", "note": ""}
    data = make_data(tmp_path, [pick], articles=ARTICLES + [extra])
    result = run(data)
    assert result.returncode == 0, result.stderr
    finding = json.loads((data / "findings" / "2026-W45.json").read_text())
    assert finding["names_person"] is False
    assert [b["kind"] for b in finding["bullets"]] == ["news", "news"]
