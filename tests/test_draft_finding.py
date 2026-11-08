"""
Ownership Finding of the Week: the drafting script turns the owner's pick into
share-ready text built only from what the site already publishes.

The guard that matters most: nothing the register gate withholds (no source
link, quarantined, or a person on a headline alone) can reach a draft, and a
person is never named without a published register row behind them. All
offline, fixtures only.
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
        "Quarantined": False, "Confidence": "Full article",
    },
    {
        "Person Name": "Tony O. Elumelu", "Company": "United Bank for Africa (UBA) Plc",
        "Percentage": "24.5%", "Nature of Control": "Indirect ownership via Heirs Holdings Limited",
        "Board Role": "", "Kind": "stake", "Person Key": "tony elumelu",
        "Company Key": "united bank for africa",
        "Date": "2026-06-18", "Source URL": "https://punchng.com/uba-chairman/",
        "Source Title": "UBA welcomes new chairman", "Publisher": "The Punch",
        "Quarantined": False, "Confidence": "Full article",
    },
    # Withheld: no source link.
    {
        "Person Name": "Zed Unsourced", "Company": "Seplat", "Percentage": "61.5%",
        "Nature of Control": "Ownership of shares", "Date": "2026-10-20",
        "Source": "", "Source URL": "", "Confidence": "Full article",
    },
    # Withheld: quarantined by the gate.
    {
        "Person Name": "Quin Quarantined", "Company": "Quarantined Ltd", "Percentage": "",
        "Nature of Control": "Significant influence", "Date": "2026-10-20",
        "Source URL": "https://example.test/q", "Quarantined": True, "Confidence": "Full article",
    },
]

ARTICLES = [
    {
        "Time": "2026-11-02T08:00:00Z", "Title": "Seplat output rises in third quarter",
        "Source": "BusinessDay", "URL": "https://businessday.ng/seplat-output/",
        # A regulator the script can tell is an organisation (it ends in an
        # entity word); a bare acronym could be anyone's initials.
        "Entities": "Seplat|Nigerian Upstream Petroleum Regulatory Commission",
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


def make_data(tmp_path, picks, register=REGISTER, articles=ARTICLES, people=PEOPLE, unpublished=(), companies=()):
    data = tmp_path / "data"
    (data / "findings").mkdir(parents=True)
    (data / "significant_control.json").write_text(json.dumps(register))
    (data / "latest.json").write_text(json.dumps(articles))
    (data / "people.json").write_text(json.dumps(people))
    (data / "companies.json").write_text(json.dumps(list(companies)))
    (data / "findings" / "picks.json").write_text(json.dumps(picks))
    if unpublished:
        (data / "suppressed.json").write_text(json.dumps(
            [{"name": n, "reason": "dispute upheld"} for n in unpublished]))
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


def test_register_bullets_name_their_row_by_the_sites_keys(tmp_path):
    # The build recheck matches each register bullet to its own row by
    # personKey/companyKey (web/src/lib/psc.ts), not by the link alone.
    pick = {"week": "2026-W46", "record_ref": "tony-elumelu/united-bank-for-africa-uba-plc",
            "headline": "Elumelu and UBA", "note": ""}
    data = make_data(tmp_path, [pick])
    assert run(data).returncode == 0
    finding = json.loads((data / "findings" / "2026-W46.json").read_text())
    register = [b for b in finding["bullets"] if b["kind"] == "register"]
    assert register
    for b in register:
        assert b["record"] == {"person": "tony elumelu", "company": "united bank for africa"}
    # An older row with no keys falls back to the lower-cased names, as the site does.
    data = make_data(tmp_path / "seplat", [ENTITY_PICK])
    assert run(data).returncode == 0
    finding = json.loads((data / "findings" / "2026-W45.json").read_text())
    assert finding["bullets"][0]["record"] == {"person": "tony elumelu", "company": "seplat"}


REFINERY_PICK = {"week": "2026-W45", "entity": "dangote-petroleum-refinery", "headline": "Refinery week", "note": ""}
REFINERY_NEWS = dict(ARTICLES[-1], URL="https://punchng.com/dangote-2/", Time="2026-11-05T08:00:00Z",
                     Title="Dangote refinery cuts petrol price")


@pytest.mark.parametrize("pick, article", [
    # The headline names a person the register backs.
    (dict(REFINERY_PICK, headline="Tony Elumelu and the refinery"), REFINERY_NEWS),
    # A news bullet names one.
    (REFINERY_PICK, dict(REFINERY_NEWS, Title="Tony Elumelu backs Dangote refinery expansion")),
    # A news bullet is tagged with a person the register backs but its title
    # does not name. (A tag that is neither a company nor a published holder
    # keeps the article out altogether: see the withheld-holder tests below.)
    (REFINERY_PICK, dict(REFINERY_NEWS, Entities="Dangote Petroleum Refinery|Tony Elumelu")),
])
def test_company_finding_naming_a_person_anywhere_stays_out_of_search(tmp_path, pick, article):
    data = make_data(tmp_path, [pick], articles=ARTICLES + [article])
    result = run(data)
    assert result.returncode == 0, result.stderr
    assert json.loads((data / "findings" / "2026-W45.json").read_text())["names_person"] is True


def test_refuses_a_company_only_in_withheld_rows(tmp_path):
    # News mentions it, but the register gate withholds every row naming it,
    # so the site would drop the finding at build without saying why.
    news = [dict(ARTICLES[0], URL=f"https://businessday.ng/q{i}/", Title=f"Quarantined Ltd update {i}",
                 Entities="Quarantined Ltd") for i in range(2)]
    pick = {"week": "2026-W45", "entity": "quarantined-ltd", "headline": "x", "note": ""}
    data = make_data(tmp_path, [pick], articles=news)
    result = run(data)
    assert result.returncode == 1
    assert "withheld" in result.stderr
    assert not (data / "findings" / "2026-W45.json").exists()


BOLA_NEWS = [
    {"Time": "2026-11-05T08:00:00Z", "Title": "Bola Newman buys stake in coastal shipping firm",
     "Source": "BusinessDay", "URL": "https://businessday.ng/bola-1/", "Entities": "Bola Newman"},
    {"Time": "2026-11-04T08:00:00Z", "Title": "Bola Newman named chairman",
     "Source": "Vanguard", "URL": "https://vanguardngr.com/bola-2/", "Entities": "Bola Newman"},
]
BOLA_PICK = {"week": "2026-W45", "entity": "bola-newman", "headline": "Bola Newman's quiet shipping stake", "note": ""}


def test_refuses_an_entity_it_cannot_confirm_is_a_company(tmp_path):
    # No register row and no appointment names "Bola Newman" as a company, so
    # the pick may well be a person the register does not back. The script
    # must not draft (and index) a page naming them.
    data = make_data(tmp_path, [BOLA_PICK], articles=BOLA_NEWS)
    result = run(data)
    assert result.returncode == 1
    assert "not a company" in result.stderr
    assert not (data / "findings" / "2026-W45.json").exists()


def test_names_person_does_not_take_the_pick_itself_as_proof_of_a_company():
    # A tag that matches only the pick's own slug is no evidence the pick is a
    # company, so names_person must stay unsure (True).
    bullets = [draft_finding._news_bullet(a) for a in BOLA_NEWS]
    assert draft_finding.names_person(BOLA_PICK, bullets, REGISTER, BOLA_NEWS, PEOPLE) is True


# Names the owner unpublished (suppressed.json, scripts/unpublish.py): the
# site leaves out everything naming them, so a draft must never use them.

@pytest.mark.parametrize("pick", [
    # Named only in the headline: no data file names them at all.
    dict(REFINERY_PICK, headline="Alhaji Tolu O. Bakare and the refinery"),
    dict(REFINERY_PICK, note="Tolu Bakare is linked to the buyer."),
    # The pick itself, as an entity or as one holding.
    dict(ENTITY_PICK, entity="tolu-bakare"),
    {"week": "2026-W46", "record_ref": "tony-elumelu/seplat", "headline": "Elumelu and Seplat", "note": ""},
])
def test_refuses_a_pick_naming_an_unpublished_entity(tmp_path, pick):
    data = make_data(tmp_path, [pick], articles=ARTICLES + [REFINERY_NEWS], unpublished=["Tolu Bakare", "Tony Elumelu"])
    result = run(data)
    assert result.returncode == 1
    assert "unpublished" in result.stderr
    assert not list((data / "findings").glob("2026-W*.json"))


def test_leaves_out_rows_and_news_naming_an_unpublished_entity(tmp_path):
    # Both are the newest facts about Seplat, so either would make the cut.
    row = dict(REGISTER[0], Percentage="30%", Date="2026-11-06", Confidence="Full article",
               **{"Nature of Control": "Indirect ownership via Hidden Holdings Ltd",
                  "Source URL": "https://punchng.com/elumelu-hidden/"})
    news = {"Time": "2026-11-06T08:00:00Z", "Title": "Seplat sells marginal field unit to Hidden Holdings Ltd",
            "Source": "The Punch", "URL": "https://punchng.com/seplat-hidden/", "Entities": "Seplat|Hidden Holdings Ltd"}
    data = make_data(tmp_path, [ENTITY_PICK], register=REGISTER + [row], articles=ARTICLES + [news],
                     unpublished=["Hidden Holdings Ltd"])
    result = run(data)
    assert result.returncode == 0, result.stderr
    text = (data / "findings" / "2026-W45.json").read_text()
    assert "Hidden Holdings" not in text
    assert "https://punchng.com/elumelu-seplat/" in text


# The register gate's own rule (web/src/lib/psc.ts isPublic, #166): a row
# naming a person also needs a confidence tier, and a claim about a person on
# a headline alone (Quality "unverified_person") waits for the owner.

@pytest.mark.parametrize("row, public", [
    (REGISTER[0], True),
    # Held for the owner's review.
    (dict(REGISTER[0], Quality=["unverified_person", "no_filing"], Confidence="Headline only"), False),
    # Exported before rows carried a tier: nothing says it rests on more than a headline.
    ({k: v for k, v in REGISTER[0].items() if k != "Confidence"}, False),
    # A company holding a company needs no tier, even through a direct holding.
    ({"Person Name": "Heirs Holdings Limited", "Company": "Transcorp Plc", "Intermediate Entities": "Direct holding",
      "Source URL": "https://punchng.com/heirs/"}, True),
    # A company holder whose previous holder is a person is a claim about that person.
    ({"Person Name": "Heirs Holdings Limited", "Company": "Transcorp Plc", "Previous Holder": "Ada Seller",
      "Source URL": "https://punchng.com/heirs/"}, False),
    (dict(REGISTER[0], Quarantined="true"), False),
    (dict(REGISTER[0], **{"Source URL": "punchng.com/no-scheme"}), False),
])
def test_is_public_is_the_sites_gate(row, public):
    assert draft_finding.is_public(row) is public


# Since #166 the pipeline exports no withheld row: a headline-only holder goes
# to the private review queue, not significant_control.json, and PSC holders
# are not in people.json either. The only trace in the data is the news that
# named them, so anyone a story tags who may be a person and is neither a
# published holder nor a company the data knows counts as unbacked.

WITHHELD_NEWS = {"Time": "2026-11-06T08:00:00Z", "Title": "Zara Headline buys 30% of Seplat",
                 "Source": "Vanguard", "URL": "https://vanguardngr.com/zara-seplat/", "Entities": "Seplat|Zara Headline"}


@pytest.mark.parametrize("field", ["headline", "note"])
def test_refuses_a_pick_naming_a_holder_the_gate_keeps_out_of_the_export(tmp_path, field):
    pick = dict(ENTITY_PICK, **{field: "Zara Headline's quiet Seplat stake"})
    data = make_data(tmp_path, [pick], articles=ARTICLES + [WITHHELD_NEWS])
    result = run(data)
    assert result.returncode == 1
    assert "Zara Headline" in result.stderr
    assert not (data / "findings" / "2026-W45.json").exists()


def test_leaves_out_news_naming_a_holder_the_gate_keeps_out_of_the_export(tmp_path):
    # The newest Seplat story, so it would make the cut. Another story tags
    # them by surname alone, which is no more a company than the full name.
    surname = dict(WITHHELD_NEWS, URL="https://vanguardngr.com/zara-2/", Time="2026-11-05T08:00:00Z",
                   Title="Seplat board meets new investor", Entities="Seplat|Headline")
    data = make_data(tmp_path, [ENTITY_PICK], articles=ARTICLES + [WITHHELD_NEWS, surname])
    result = run(data)
    assert result.returncode == 0, result.stderr
    finding = json.loads((data / "findings" / "2026-W45.json").read_text())
    text = json.dumps(finding)
    assert "Zara" not in text and "zara" not in text
    assert "https://vanguardngr.com/zara-2/" not in text
    assert "https://businessday.ng/seplat-output/" in text


def test_a_published_holder_and_known_companies_are_not_unbacked(tmp_path):
    # Tagged by another spelling of a published holder (title and initial)
    # and by a company alias the register folds into Seplat. Another story
    # tags a bare surname, which the headline and title only use inside the
    # holder's full name. (A bare "Elumelu" on its own could be anyone called
    # Elumelu, so it would count.)
    news = {"Time": "2026-11-06T08:00:00Z", "Title": "Tony Elumelu raises Seplat Energy stake",
            "Source": "Vanguard", "URL": "https://vanguardngr.com/elumelu-seplat/",
            "Entities": "Seplat Energy|Alhaji Tony O. Elumelu"}
    surname = dict(news, URL="https://vanguardngr.com/elumelu-2/", Time="2026-11-05T08:00:00Z", Entities="Seplat|Elumelu")
    pick = dict(ENTITY_PICK, headline="Tony Elumelu's Seplat Energy stake")
    data = make_data(tmp_path, [pick], articles=ARTICLES + [news, surname])
    result = run(data)
    assert result.returncode == 0, result.stderr
    text = (data / "findings" / "2026-W45.json").read_text()
    assert "https://vanguardngr.com/elumelu-seplat/" in text


def test_a_company_with_a_real_industry_is_not_unbacked(tmp_path):
    # companies.json files often-mentioned people under companies too
    # ("Tinubu", Industry "General"); a real industry is the sign #164's
    # isKnownCompany() takes for a company.
    news = {"Time": "2026-11-06T08:00:00Z", "Title": "OPay and Seplat sign payments deal",
            "Source": "Vanguard", "URL": "https://vanguardngr.com/opay-seplat/", "Entities": "Seplat|OPay|Tinubu"}
    companies = [{"Company": "OPay", "Industry": "Fintech / Payments"}, {"Company": "Tinubu", "Industry": "General"}]
    data = make_data(tmp_path, [dict(ENTITY_PICK, note="OPay is a new partner.")], articles=ARTICLES + [news], companies=companies)
    result = run(data)
    assert result.returncode == 0, result.stderr
    # The story is still left out: it is tagged with Tinubu, who may be a person.
    assert "opay-seplat" not in (data / "findings" / "2026-W45.json").read_text()
    data = make_data(tmp_path / "tinubu", [dict(ENTITY_PICK, note="Tinubu backs the deal.")], articles=ARTICLES + [news],
                     companies=companies)
    result = run(data)
    assert result.returncode == 1
    assert "Tinubu" in result.stderr
