"""Unpublished names (scripts/unpublish.py) and the export filter that hides them."""
import json

from backend.app.services import suppression


def test_load_reads_names_and_tolerates_a_missing_or_broken_file(tmp_path):
    assert suppression.load(str(tmp_path)) == []
    (tmp_path / "suppressed.json").write_text("not json")
    assert suppression.load(str(tmp_path)) == []
    (tmp_path / "suppressed.json").write_text(json.dumps([
        {"name": "Ada Obi", "added": "2026-11-07", "reason": "dispute upheld"},
        {"name": "  "},
        "junk",
    ]))
    assert suppression.load(str(tmp_path)) == ["Ada Obi"]


def test_names_matches_whole_words_case_insensitively():
    hidden = ["Aliko Dangote"]
    assert suppression.names("Alhaji ALIKO Dangote", hidden)
    assert suppression.names("Aliko Dangote said on Monday", hidden)
    assert not suppression.names("Aliko Dangotes", hidden)
    assert not suppression.names("Dangote Cement", hidden)
    assert not suppression.names("", hidden)
    assert not suppression.names("Aliko Dangote", [])


def test_scrub_drops_every_row_that_names_a_hidden_entity():
    hidden = ["Ada Obi", "Kola Holdings"]
    tables = suppression.scrub(
        hidden,
        articles=[
            {"Title": "Ada Obi buys stake", "Summary": "", "Entities": "Ada Obi"},
            {"Title": "Bank results", "Summary": "", "Entities": "Kola Holdings Ltd|First Bank"},
            {"Title": "Market wrap", "Summary": "Shares rose", "Entities": "First Bank|NGX"},
        ],
        companies=[{"Company": "Kola Holdings"}, {"Company": "First Bank"}],
        people=[{"Name": "Ada Obi", "Organization": "X"}, {"Name": "Bisi", "Organization": "Kola Holdings"},
                {"Name": "Bisi", "Organization": "First Bank"}],
        agencies=[{"Agency": "CBN"}],
        procurement=[{"Agency": "FMW", "Contractor": "Kola Holdings Limited"}, {"Agency": "FMW", "Contractor": "Julius Berger"}],
        psc=[{"Person Name": "Alhaja Ada Obi", "Company": "Zenith"}, {"Person Name": "Jim", "Company": "Zenith"}],
    )
    assert [a["Title"] for a in tables["articles"]] == ["Market wrap"]
    assert tables["companies"] == [{"Company": "First Bank"}]
    assert tables["people"] == [{"Name": "Bisi", "Organization": "First Bank"}]
    assert tables["agencies"] == [{"Agency": "CBN"}]
    assert [r["Contractor"] for r in tables["procurement"]] == ["Julius Berger"]
    assert [r["Person Name"] for r in tables["psc"]] == ["Jim"]


def test_scrub_with_nothing_hidden_returns_the_same_rows():
    rows = [{"Company": "A"}]
    assert suppression.scrub([], companies=rows)["companies"] is rows


def test_alerts_naming_a_hidden_entity_are_dropped():
    alerts = [
        {"title": "EFCC raids Kola Holdings", "entities": []},
        {"title": "Fraud probe", "entities": ["Kola Holdings"]},
        {"title": "CBN fines bank", "entities": ["CBN"]},
    ]
    assert suppression.drop_alerts(alerts, ["Kola Holdings"]) == [alerts[2]]
