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
               ("Dangote Cement posts results", "Dangote Cement"),
               ("Tolu Bakare sells Ikeja Mills stake to Ann Okafor", "Ikeja Mills")]
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
    # Saved before rows carried their article: the source backfill must not
    # give it the one story that names the hidden person.
    d._append_row("Significant Control", {"Person Name": "Ann Okafor", "Company": "Ikeja Mills",
                                          "Percentage": "20%", "Date": today})
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
    # Run as a local export, with no live hosts: side feeds and og:image
    # lookups are network-only and not under test. attach_images itself is
    # replaced, since its fetch default is bound when it is defined.
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.setattr(rp.side_feeds, "export_side_feeds", lambda *a, **k: None)
    monkeypatch.setattr(rp.article_images, "attach_images", lambda rows, cache, **k: 0)
    monkeypatch.setattr(weather_mod, "fetch_weather", lambda *a, **k: None)
    monkeypatch.setattr(trends_mod, "fetch_reddit_nigeria", lambda *a, **k: [])
    rp.export_static_json_database()

    for name in ("significant_control.json", "people.json", "latest.json", "graph.json",
                 "alerts.json", "email_digest.json", "entity_timeline.json", "changes.json"):
        assert "Tolu Bakare" not in (out / name).read_text(), name
    # Only rows naming the person go; the rest of the export is untouched.
    assert "Dangote Cement" in (out / "latest.json").read_text()
    assert "Dangote Cement" in (out / "companies.json").read_text()


def test_a_holders_evidence_never_quotes_a_hidden_co_party(tmp_path, monkeypatch):
    """A public row's Evidence quote is lifted from its source article. When
    that article also names a hidden person, the quote must not carry the
    name into significant_control.json, and the row itself stays: it is
    the co-party's legitimate claim, and dropping it on the site would list
    it as new in changes.json on every run."""
    import run_pipeline as rp
    from backend.app.db.excel_db import SheetsDatabase
    import backend.app.services.trends as trends_mod

    d = SheetsDatabase()
    d.use_local = True
    d.local_path = str(tmp_path / "db.xlsx")
    d._cache = {}
    d._init_db()
    today = datetime.utcnow().strftime("%Y-%m-%d")
    d._append_row("Articles", {"ID": 1, "Time": f"{today}T07:00:00Z",
                               "Title": "Ikeja Mills gets a new top shareholder",
                               "Source": "The Punch", "URL": "https://punchng.com/1",
                               "Category": "Corporate", "Risk Score": 70,
                               "Summary": "A change at Ikeja Mills.",
                               "Key Facts": "Ann Okafor bought Tolu Bakare's 20% stake in Ikeja Mills. "
                                            "| The deal closed in October.",
                               "Status": "Unread", "Engine": "claude", "Entities": "Ann Okafor|Ikeja Mills"})
    d._append_row("Companies", {"Company": "Ikeja Mills", "Mention Count": 4, "Last Seen": today})
    d._append_row("Significant Control", {"Person Name": "Ann Okafor", "Company": "Ikeja Mills",
                                          "Nature of Control": "Ownership of shares",
                                          "Percentage": "20%", "Date": today, "Source": "extracted",
                                          "Source URL": "https://punchng.com/1",
                                          "Source Title": "Ikeja Mills gets a new top shareholder",
                                          "Basis": "article", "Change Type": "acquired"})
    out = tmp_path / "data"
    (out / "archives").mkdir(parents=True)
    (out / "suppressed.json").write_text(json.dumps([{"name": "Tolu Bakare", "added": today}]))
    monkeypatch.setattr(rp, "db", d)
    monkeypatch.setattr(rp, "DATA_DIR", str(out))
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.setattr(rp.side_feeds, "export_side_feeds", lambda *a, **k: None)
    monkeypatch.setattr(rp.article_images, "attach_images", lambda rows, cache, **k: 0)
    monkeypatch.setattr(trends_mod, "fetch_reddit_nigeria", lambda *a, **k: [])

    rp.export_static_json_database()
    register = (out / "significant_control.json").read_text()
    assert "Tolu Bakare" not in register
    assert [r["Person Name"] for r in json.loads(register)] == ["Ann Okafor"]

    # The next run diffs against that file: the holding is not new again.
    rp.export_static_json_database()
    changes = json.loads((out / "changes.json").read_text())
    assert changes["psc_added"] == []
    assert "Tolu Bakare" not in (out / "significant_control.json").read_text()


def test_a_kept_previous_file_does_not_bring_back_a_hidden_name(tmp_path, monkeypatch):
    """When a run's read collapses, the shrink guard (core_rows) keeps the
    previous files. Those were written before the name was unpublished, so
    they are scrubbed first: nothing is re-published, and changes.json,
    whose previous side is scrubbed too, lists nothing as new."""
    import run_pipeline as rp
    from backend.app.db.excel_db import SheetsDatabase
    import backend.app.services.trends as trends_mod

    d = SheetsDatabase()
    d.use_local = True
    d.local_path = str(tmp_path / "db.xlsx")
    d._cache = {}
    d._init_db()
    out = tmp_path / "data"
    (out / "archives").mkdir(parents=True)
    (out / "suppressed.json").write_text(json.dumps([{"name": "Tolu Bakare", "added": "2026-11-07"}]))
    (out / "latest.json").write_text(json.dumps(
        [{"Title": f"Story {i}", "URL": f"https://punchng.com/s{i}", "Risk Score": 80} for i in range(29)]
        + [{"Title": "Tolu Bakare takes control of Ikeja Mills", "URL": "https://punchng.com/tb",
            "Risk Score": 80}]))
    (out / "companies.json").write_text(json.dumps(
        [{"Company": f"Firm {i} Ltd"} for i in range(24)] + [{"Company": "Tolu Bakare Holdings Ltd"}]))
    (out / "people.json").write_text(json.dumps(
        [{"Name": f"Person {i}"} for i in range(24)] + [{"Name": "Tolu Bakare"}]))
    (out / "significant_control.json").write_text(json.dumps(
        [{"Person Name": f"Holder {i}", "Company": f"Firm {i} Ltd", "Percentage": "10%"} for i in range(24)]
        + [{"Person Name": "Tolu Bakare", "Company": "Ikeja Mills", "Percentage": "60%"}]))
    monkeypatch.setattr(rp, "db", d)
    monkeypatch.setattr(rp, "DATA_DIR", str(out))
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.setattr(rp.side_feeds, "export_side_feeds", lambda *a, **k: None)
    monkeypatch.setattr(rp.article_images, "attach_images", lambda rows, cache, **k: 0)
    monkeypatch.setattr(trends_mod, "fetch_reddit_nigeria", lambda *a, **k: [])
    rp.export_static_json_database()

    kept = {"latest.json": 29, "companies.json": 24, "people.json": 24, "significant_control.json": 24}
    for name, rows in kept.items():
        text = (out / name).read_text()
        assert "Tolu Bakare" not in text, name
        assert len(json.loads(text)) == rows, name
    for name in ("changes.json", "graph.json", "psc_timeline.json"):
        assert "Tolu Bakare" not in (out / name).read_text(), name


def test_the_daily_brief_and_its_archive_leave_out_a_hidden_name(tmp_path, monkeypatch):
    """report_latest.md and archives/*.md are served at /data/: the brief is
    built only from stories that do not name an unpublished entity."""
    import run_pipeline as rp
    from backend.app.services.llm import LLMService

    class Db:
        def get_daily_reports(self):
            return []

        def add_daily_report(self, row):
            pass

    sent = []

    def generate(cls, raw):
        sent.append(raw)
        return "", "test"  # no model text: the rule-based brief lists the records

    def record(url, title, event="Appointment"):
        return {"title": title, "source": "Punch", "url": url, "basis": "article",
                "analysis": {"summary": title, "risk_level": "High", "event_type": event}}

    records = [record("https://punchng.com/a", "Tolu Bakare named chairman of Ikeja Mills"),
               record("https://punchng.com/b", "Ann Okafor named chief executive of Lagos Foods")]
    prior = [record("https://punchng.com/c", "Ikeja Mills board backs Tolu Bakare", event="")]
    (tmp_path / "suppressed.json").write_text(json.dumps([{"name": "Tolu Bakare", "added": "2026-11-07"}]))
    monkeypatch.setattr(rp, "db", Db())
    monkeypatch.setattr(rp, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(rp.settings, "ALLOW_HEURISTIC_FALLBACK", True)
    monkeypatch.setattr(LLMService, "generate_daily_report", classmethod(generate))
    rp.compile_daily_report(records, prior)

    assert "Tolu Bakare" not in sent[0]
    [archive] = list((tmp_path / "archives").glob("*.md"))
    for path in (tmp_path / "report_latest.md", archive):
        brief = path.read_text(encoding="utf-8")
        assert "Tolu Bakare" not in brief, path.name
        assert "Ann Okafor" in brief, path.name


def test_evidence_skips_a_sentence_naming_a_hidden_entity():
    """The hidden list is matched like the export's scrub: spelling
    variants and companies too, not only the gate's canonical people."""
    from backend.app.services import register_quality as rq

    article = {"URL": "https://punchng.com/9", "Time": "",
               "Key Facts": "Ann Okafor bought Alhaji TOLU Bakare's stake. | "
                            "Ann Okafor now owns 20% of Ikeja Mills."}
    row = {"Person Name": "Ann Okafor", "Company": "Ikeja Mills", "Source URL": "https://punchng.com/9"}
    [out] = rq.attach_evidence([row], [article], "now",
                               unpublished=suppression.matcher(["Tolu Bakare"]))
    assert out["Evidence"]["quote"] == "Ann Okafor now owns 20% of Ikeja Mills."
    [out] = rq.attach_evidence([row], [article], "now",
                               unpublished=suppression.matcher(["Tolu Bakare", "Ikeja Mills Plc"]))
    assert out["Evidence"]["quote"] == ""
    # Without the list, the first sentence would have been quoted.
    [out] = rq.attach_evidence([row], [article], "now")
    assert "Bakare" in out["Evidence"]["quote"]


def test_no_test_writes_the_owners_review_queue(tmp_path):
    """The export writes the gate's review queue (run_pipeline.REVIEW_QUEUE_PATH),
    which is private and git-ignored: tests/conftest.py points it at each
    test's own directory, so a test run never overwrites the owner's copy."""
    import run_pipeline as rp

    assert rp.REVIEW_QUEUE_PATH == str(tmp_path / "review_queue.json")


def test_the_sites_copy_of_the_canonical_lists_matches_the_pipeline():
    """web/src/lib/suppressed.ts ports canonical_person/canonical_company;
    a word added here but not there would hide a name in one place only."""
    import re
    from pathlib import Path
    from backend.app.services import register_quality as rq

    ts = (Path(__file__).resolve().parents[1] / "web/src/lib/suppressed.ts").read_text()

    def block(name):
        body = re.search(rf"const {name}\b[^=]*= (?:new Set\(\[|\{{)(.*?)(?:\]\)|\}});", ts, re.S).group(1)
        return re.findall(r'"([^"]+)"', body)

    assert set(block("HONORIFICS")) == rq._HONORIFICS
    assert set(block("COMPANY_SUFFIXES")) == rq._COMPANY_SUFFIXES
    pairs = block("COMPANY_ALIASES")
    assert dict(zip(pairs[::2], pairs[1::2])) == rq._COMPANY_ALIASES
