"""Unpublished names (scripts/unpublish.py) and the export filter that hides them."""
import json
from datetime import datetime

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


def test_scrub_drops_rows_that_name_a_hidden_entity_in_any_column():
    """Free-text columns are published too (Key Facts in the digest cards,
    Previous Holder and Source Title on the register, Event on people)."""
    tables = suppression.scrub(
        ["Zed Hidden"],
        psc=[{"Person Name": "Ann Other", "Company": "Acme Plc", "Previous Holder": "Zed Hidden"},
             {"Person Name": "Ann Other", "Company": "Acme Plc", "Source Title": "Zed Hidden sells Acme stake"},
             {"Person Name": "Ann Other", "Company": "Acme Plc", "Percentage": 40}],
        articles=[{"Title": "Acme changes hands", "Key Facts": "Seller: Zed Hidden"},
                  {"Title": "Acme changes hands", "Detail": {"para": ["Zed Hidden sold 40%"]}}],
        people=[{"Name": "Ann Other", "Organization": "Acme", "Event": "Replaces Zed Hidden as chairman"}],
    )
    assert {k: len(v) for k, v in tables.items()} == {"psc": 1, "articles": 0, "people": 0}


def test_names_match_the_registers_canonical_forms():
    """A middle initial, an honorific or a legal suffix does not make a
    different entity (register_quality.canonical_person/canonical_company)."""
    assert suppression.names("Tony O. Elumelu", ["Tony Elumelu"])
    assert suppression.names("Tony Elumelu", ["Chief Tony O. Elumelu"])
    assert suppression.names("Profits at Dangote Cement rise", ["Dangote Cement Plc"])
    assert suppression.names("Dangote Petroleum Refinery", ["Dangote Refinery"])
    assert suppression.scrub(["Zedekiah Varianttest"], psc=[
        {"Person Name": "Zedekiah Q. Varianttest", "Company": "Sentinel Mills Plc"}])["psc"] == []
    # A suffix-only key would be one common word: "Access Holdings" must not
    # hide every story that says "access".
    assert not suppression.names("Banks widen access to credit", ["Access Holdings"])
    assert suppression.names("Access", ["Access Holdings"])


def test_scrub_with_nothing_hidden_returns_the_same_rows():
    rows = [{"Company": "A"}]
    assert suppression.scrub([], companies=rows)["companies"] is rows


def test_alerts_naming_a_hidden_entity_are_dropped():
    alerts = [
        {"title": "EFCC raids Kola Holdings", "entities": []},
        {"title": "Fraud probe", "entities": ["Kola Holdings"]},
        {"title": "CBN fines bank", "entities": ["CBN"]},
    ]
    assert suppression.without(alerts, ["Kola Holdings"]) == [alerts[2]]


def test_no_export_or_the_digest_carries_a_suppressed_name(tmp_path, monkeypatch):
    """The export is the one place names leave: every file it writes is
    built from rows that have already been scrubbed."""
    import run_pipeline as rp
    from backend.app.db.excel_db import SheetsDatabase
    import backend.app.services.trends as trends_mod
    import backend.app.services.weather as weather_mod

    d = SheetsDatabase()
    d.use_local = True
    d.local_path = str(tmp_path / "db.xlsx")
    d._cache = {}
    d._init_db()
    today = datetime.utcnow().strftime("%Y-%m-%d")
    stories = [("Tolu Bakare takes control of Ikeja Mills", "Tolu Bakare|Ikeja Mills"),
               ("Dangote Cement posts results", "Dangote Cement")]
    for i, (title, ents) in enumerate(stories):
        d._append_row("Articles", {"ID": i + 1, "Time": f"{today}T07:00:00Z", "Title": title,
                                   "Source": "The Punch", "URL": f"https://punchng.com/{i}",
                                   "Category": "Corporate", "Risk Score": 70, "Summary": title,
                                   "Status": "Unread", "Engine": "claude", "Entities": ents})
    d._append_row("Companies", {"Company": "Ikeja Mills", "Mention Count": 4, "Last Seen": today})
    d._append_row("Companies", {"Company": "Dangote Cement", "Mention Count": 4, "Last Seen": today})
    d._append_row("People", {"Name": "Tolu Bakare", "Position": "Chairman", "Organization": "Ikeja Mills",
                             "Event": "appointment", "Date": today})
    d._append_row("Significant Control", {"Person Name": "Chief Tolu Bakare", "Company": "Ikeja Mills",
                                          "Percentage": "60%", "Date": today,
                                          "Source URL": "https://punchng.com/0", "Source Title": "x"})
    d._append_row("Alerts", {"Date": today, "Title": "Tolu Bakare takes control of Ikeja Mills",
                             "URL": "https://punchng.com/0", "Risk Score": 70, "Entities": "Tolu Bakare"})

    out = tmp_path / "data"
    (out / "archives").mkdir(parents=True)
    (out / "suppressed.json").write_text(json.dumps([{"name": "Tolu Bakare", "added": today}]))
    # A snapshot from before the name was hidden: the cycle diff must not
    # publish it again as "removed".
    (out / "people.json").write_text(json.dumps([{"Name": "Tolu Bakare"}]))
    monkeypatch.setattr(rp, "db", d)
    monkeypatch.setattr(rp, "DATA_DIR", str(out))
    monkeypatch.setattr(weather_mod, "fetch_weather", lambda *a, **k: None)
    monkeypatch.setattr(trends_mod, "fetch_reddit_nigeria", lambda *a, **k: [])
    rp.export_static_json_database()

    for name in ("significant_control.json", "people.json", "latest.json", "graph.json",
                 "alerts.json", "email_digest.json", "entity_timeline.json", "changes.json"):
        assert "Tolu Bakare" not in (out / name).read_text(), name
    # Only rows naming the person go; the rest of the export is untouched.
    assert "Dangote Cement" in (out / "latest.json").read_text()
    assert "Dangote Cement" in (out / "companies.json").read_text()
