"""
The person rule in the publish gate, the confidence tier on every record,
and the review queue that holds what the gate keeps back.

A record naming a person is a claim about that person. It is published only
when it rests on more than a headline: a regulatory filing reference, the
full article text, or the owner's approval in the sheet.
"""
from backend.app.services import register_quality as q


def row(**kw):
    base = {
        "Person Name": "Abubakar Musa", "Company": "Kano Flour Mills Plc",
        "Nature of Control": "Ownership of shares", "Percentage": "12%",
        "Date": "2026-10-01", "Source": "extracted",
        "Source URL": "https://punchng.com/kano-flour/", "Regulatory Filing Ref": "",
    }
    base.update(kw)
    return base


class TestPersonRule:
    def test_headline_only_person_record_is_withheld(self):
        r = q.annotate([row(Basis="headline")])[0]
        assert "unverified_person" in r["Quality"]
        assert q.is_public(r) is False

    def test_full_article_person_record_is_published(self):
        assert q.is_public(q.annotate([row(Basis="article")])[0]) is True

    def test_filing_reference_publishes_a_headline_record(self):
        r = row(Basis="headline", **{"Regulatory Filing Ref": "CAC/PSC/2026/1187-KFM"})
        assert q.is_public(q.annotate([r])[0]) is True

    def test_legacy_row_without_basis_counts_as_headline(self):
        assert q.is_public(q.annotate([row()])[0]) is False

    def test_owner_approval_passes_the_person_rule(self):
        for value in ("yes", "Yes", " YES "):
            assert q.is_public(q.annotate([row(Approved=value)])[0]) is True
        assert q.is_public(q.annotate([row(Approved="no")])[0]) is False

    def test_approval_does_not_excuse_a_missing_source(self):
        r = q.annotate([row(Approved="yes", **{"Source URL": ""})])[0]
        assert q.is_public(r) is False

    def test_unannotated_rows_are_judged_too(self):
        assert q.is_public(row(Basis="headline")) is False
        assert q.is_public(row(Basis="article")) is True

    def test_company_holder_is_not_held_to_the_person_rule(self):
        r = row(**{"Person Name": "Heirs Holdings Limited"})
        assert q.is_public(q.annotate([r])[0]) is True
        assert q.is_public(q.annotate([row(**{"Person Name": "Sahel Nominees"})])[0]) is True
        assert q.is_public(q.annotate([row(**{"Person Name": ""})])[0]) is True

    def test_placeholder_filing_refs_are_not_filings(self):
        # The extraction prompt's own example and bare words are not references.
        for ref in ("null", "SEC disclosure", "CAC/PSC/2026/0891", "pending", ""):
            assert q.has_filing_ref(row(**{"Regulatory Filing Ref": ref})) is False, ref
        assert q.has_filing_ref(row(**{"Regulatory Filing Ref": "RC 1234567"})) is True


class TestBasisOfExtraction:
    def test_only_full_text_counts_as_article(self):
        assert q.basis_for_detail("full") == "article"
        for detail in ("snippet", "headline", "", None):
            assert q.basis_for_detail(detail) == "headline"


class TestConfidence:
    def test_three_tiers(self):
        tiers = [q.annotate([r])[0]["Confidence"] for r in (
            row(**{"Regulatory Filing Ref": "CAC/PSC/2026/1187-KFM"}),
            row(Basis="article"),
            row(Basis="headline", Approved="yes"),
            row(),
        )]
        assert tiers == ["Official filing", "Full article", "Headline only", "Headline only"]

    def test_filing_basis_without_a_reference_is_not_an_official_filing(self):
        # The tier promises readers a reference is on record; without one the
        # owner's "filing" basis still passes the gate, as an approval.
        r = q.gate([row(**{"Person Name": "Ada Obi"}, Basis="filing")])[0]
        assert r["Confidence"] == "Headline only"
        assert q.is_public(r) is True


class TestWithheldCounts:
    def test_counts_name_the_reason_not_the_person(self):
        rows = q.gate([
            row(Basis="article"),
            row(Basis="headline", Date="2026-10-02"),
            row(**{"Source URL": ""}, Basis="article", Date="2026-10-03"),
        ])
        summary = q.withheld_summary(rows)
        assert summary == {"checked": 3, "published": 1, "unsourced": 1,
                           "implausible": 0, "needs_review": 1}
        assert "Musa" not in str(summary)


class TestReviewQueue:
    def test_lists_every_withheld_row_with_its_reasons(self):
        rows = q.gate([
            row(Basis="article"),
            row(Basis="headline", Date="2026-10-02"),
            row(**{"Person Name": "Sadio Mané"}, Basis="article", Date="2026-10-03"),
        ])
        queue = q.review_queue(rows, generated="2026-11-07 06:00:00")
        assert queue["generated"] == "2026-11-07 06:00:00"
        assert queue["counts"]["needs_review"] == 1 and queue["counts"]["implausible"] == 1
        assert [r["Person Name"] for r in queue["rows"]] == ["Abubakar Musa", "Sadio Mané"]
        assert queue["rows"][0]["Reasons"] == [q.REASONS["unverified_person"]]
        assert all(r["Reasons"] for r in queue["rows"])


class TestSheetColumns:
    def test_basis_and_approval_survive_the_column_filter(self):
        # _append_row keeps only configured columns; plan_header_migration
        # adds these to the live sheet by name.
        from backend.app.db.excel_db import SHEETS_CONFIG
        columns = SHEETS_CONFIG["Significant Control"]
        assert "Basis" in columns and "Approved" in columns


class TestBriefOwnershipLines:
    def test_each_line_says_how_strong_the_claim_is(self):
        from backend.app.services import email_digest
        rows = [
            {"Person Name": "Abubakar Musa", "Company": "Kano Flour Mills", "Percentage": "12%",
             "Source URL": "https://punchng.com/a", "Publisher": "The Punch", "Date": "2026-10-31",
             "Confidence": "Full article"},
            # An export written before tiers existed: the weakest tier, never none.
            {"Person Name": "Heirs Holdings", "Company": "Transcorp", "Percentage": "25%",
             "Source URL": "https://punchng.com/b", "Publisher": "The Punch", "Date": "2026-10-31"},
        ]
        lines, _, _ = email_digest.psc_lines(rows, since=None)
        assert sorted(line["confidence"] for line in lines) == ["Full article", "Headline only"]


class TestFilingRefShape:
    def test_words_with_a_year_are_not_references(self):
        # A model that found no filing writes these; a year is not a reference.
        for ref in ("SEC disclosure 2025", "SEC disclosure 2026", "Not filed as of 2026",
                    "Pending - 2026", "Unknown (2026)", "Announcement 2026", "2026"):
            r = row(**{"Person Name": "Ada Obi", "Regulatory Filing Ref": ref})
            assert q.has_filing_ref(r) is False, ref
            checked = q.gate([r])[0]
            assert checked["Confidence"] == "Headline only", ref
            assert q.is_public(checked) is False, ref

    def test_registry_shaped_references_count(self):
        for ref in ("RC 1234567", "RC1234567", "BN 3344556", "CAC/PSC/2026/1187-KFM", "PSC-2026-00412"):
            assert q.has_filing_ref(row(**{"Regulatory Filing Ref": ref})) is True, ref


class TestPersonDetection:
    def test_person_names_containing_entity_words_are_people(self):
        # Trust, Fund and Favour are Nigerian given names; Capital-Bello a surname.
        for name in ("Trust Okonkwo", "Fund Adeyemi", "Favour Capital-Bello", "Bank Olawale"):
            r = q.gate([row(**{"Person Name": name}, Basis="headline")])[0]
            assert q.names_person(r) is True, name
            assert "unverified_person" in r["Quality"], name
            assert q.is_public(r) is False, name

    def test_clear_company_holders_are_not_people(self):
        for name in ("Heirs Holdings Limited", "Sahel Nominees", "Stanbic IBTC Trustees",
                     "Dangote Industries Ltd", "Access Bank Plc", "Vetiva Capital Partners"):
            assert q.names_person(row(**{"Person Name": name})) is False, name

    def test_a_person_named_as_previous_holder_brings_in_the_person_rule(self):
        r = row(**{"Person Name": "Dangote Industries Ltd", "Previous Holder": "Abubakar Musa",
                   "Change Type": "acquired"}, Basis="headline")
        checked = q.gate([r])[0]
        assert "unverified_person" in checked["Quality"]
        assert q.is_public(checked) is False
        assert q.is_public(q.gate([dict(r, Basis="article")])[0]) is True

    def test_a_person_in_the_control_chain_brings_in_the_person_rule(self):
        r = row(**{"Person Name": "Dangote Industries Ltd",
                   "Intermediate Entities": "Abubakar Musa"}, Basis="headline")
        assert q.is_public(q.gate([r])[0]) is False

    def test_company_or_empty_chain_fields_leave_company_rows_alone(self):
        for prev, chain in (("Sahel Nominees", "Direct holding"), ("null", "N/A"), ("", "Direct")):
            r = row(**{"Person Name": "Dangote Industries Ltd", "Previous Holder": prev,
                       "Intermediate Entities": chain}, Basis="headline")
            assert q.is_public(q.gate([r])[0]) is True, (prev, chain)


class TestChangesFeed:
    def test_withheld_pairs_are_not_listed_as_removed(self):
        # changes.json is public: a pair the gate now withholds must not be
        # announced there by name as "removed".
        from backend.app.pipeline.report import compute_cycle_changes
        held = row(Basis="headline")
        kept = row(**{"Person Name": "Ada Obi"}, Basis="article")
        gone = row(**{"Person Name": "Heirs Holdings Limited", "Company": "Transcorp"})
        checked = q.gate([held, kept])
        prev = q.without_withheld([held, kept, gone], checked)
        changes = compute_cycle_changes({"psc": prev}, {"psc": q.public_rows(checked)})
        assert changes["psc_removed"] == [{"person": "Heirs Holdings Limited", "company": "Transcorp"}]
        assert "Musa" not in str(changes)


def story(url, holder, company, basis, **psc):
    """One run record as run_pipeline hands it to compile_daily_report."""
    return {
        "title": f"{holder} takes a stake in {company}", "source": "Punch", "url": url,
        "basis": basis,
        "analysis": {
            "summary": f"{holder} disclosed a 12% stake in {company}.", "risk_level": "Medium",
            "significant_control": [dict({"name": holder, "organization": company,
                                          "percentage": "12%",
                                          "nature_of_control": "Ownership of shares"}, **psc)],
        },
    }


class TestDailyBrief:
    """The brief is public too: report_latest.md, the home page's ownership
    aside, /brief/ and every archive. Its ownership section names every
    holder the model is given, so it is given only what the register shows."""

    def compile(self, tmp_path, monkeypatch, records, md=""):
        import json

        import run_pipeline as rp
        from backend.app.services.llm import LLMService

        class Db:
            def get_daily_reports(self):
                return []

            def add_daily_report(self, row):
                pass

        sent = []

        def generate(cls, raw):
            sent.append(json.loads(raw))
            return md, "test"

        monkeypatch.setattr(rp, "db", Db())
        monkeypatch.setattr(rp, "DATA_DIR", str(tmp_path))
        monkeypatch.setattr(LLMService, "generate_daily_report", classmethod(generate))
        rp.compile_daily_report(records)
        return sent[0], (tmp_path / "report_latest.md").read_text(encoding="utf-8")

    RECORDS = [
        story("https://punchng.com/kano-flour/", "Abubakar Musa", "Kano Flour Mills Plc", "headline"),
        story("https://punchng.com/transcorp/", "Heirs Holdings Limited", "Transcorp Plc", "headline"),
        story("https://punchng.com/lagos-foods/", "Ada Obi", "Lagos Foods Plc", "article"),
        story("https://punchng.com/sahel/", "Dangote Industries Ltd", "Sahel Mills Plc", "headline",
              previous_holder="Bola Adeyemi"),
    ]

    def test_a_headline_only_person_holding_never_reaches_the_model(self, tmp_path, monkeypatch):
        payload, _ = self.compile(tmp_path, monkeypatch, self.RECORDS)
        holders = [h["name"] for a in payload["articles"] for h in a["analysis"]["significant_control"]]
        # A company holding another company is no claim about a person, and
        # the full article supports a person; a person named on a headline
        # alone, as holder or previous holder, is held back as on the register.
        assert holders == ["Heirs Holdings Limited", "Ada Obi"]
        assert "Adeyemi" not in str([a["analysis"]["significant_control"] for a in payload["articles"]])
        assert self.RECORDS[0]["analysis"]["significant_control"], "the run's records are left alone"

    def test_the_ownership_section_never_names_a_withheld_holder(self, tmp_path, monkeypatch):
        # The model is told not to rebuild a removed holding from the
        # summary; this is the rule that holds when it does anyway.
        md = ("### Beneficial Ownership & PSC Disclosures\n"
              "- **Abubakar Musa** holds 12% of Kano Flour Mills Plc "
              "([Punch](https://punchng.com/kano-flour/))\n"
              "- **Heirs Holdings Limited** holds 12% of Transcorp Plc "
              "([Punch](https://punchng.com/transcorp/))\n")
        _, brief = self.compile(tmp_path, monkeypatch, self.RECORDS, md=md)
        assert "Musa" not in brief
        assert "Heirs Holdings Limited" in brief

    def test_the_prompt_says_withheld_holdings_were_removed(self):
        from backend.app.services.llm import build_report_prompt
        prompt = build_report_prompt("{}")
        assert "significant_control" in prompt
        assert "never rebuild" in prompt.lower()


def run_story(tmp_path, monkeypatch, text, analysis):
    """Run the pipeline over one collected story the model answers with
    `analysis`; return the records it hands the brief and the register
    rows it wrote."""
    import run_pipeline as rp
    from backend.app.db.excel_db import SheetsDatabase
    from backend.app.services.ingestion import NewsIngestionService
    from backend.app.services.llm import LLMService

    d = SheetsDatabase()
    d.use_local = True
    d.local_path = str(tmp_path / "run.xlsx")
    d._cache = {}
    d._init_db()
    monkeypatch.setattr(rp, "db", d)
    monkeypatch.setattr(rp, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(rp, "EVAL_CAPTURE_RATE", 0)
    monkeypatch.setattr(NewsIngestionService, "collect_all", classmethod(lambda cls: [
        {"title": "Abubakar Musa buys 12% of Kano Flour Mills", "source": "Punch",
         # A host that never resolves: nothing here may be fetched.
         "url": "https://kano-flour.invalid/story", "raw_text": text}]))
    monkeypatch.setattr(LLMService, "analyze_article",
                        classmethod(lambda cls, t, x: dict(analysis)))
    records = []
    monkeypatch.setattr(rp, "compile_daily_report", lambda recs, *a, **k: records.extend(recs))
    monkeypatch.setattr(rp, "export_static_json_database", lambda: None)
    monkeypatch.setattr("time.sleep", lambda s: None)
    rp.run_pipeline()
    return records, d.get_significant_control()


class TestRunRecordBasis:
    ANALYSIS = {
        "relevant": True, "engine": "claude", "category": "Business", "risk_score": 40,
        "summary": "Abubakar Musa bought 12% of Kano Flour Mills Plc.",
        "significant_control": [{"name": "Abubakar Musa", "organization": "Kano Flour Mills Plc",
                                 "percentage": "12%"}],
    }

    def test_a_record_carries_the_basis_its_register_rows_carry(self, tmp_path, monkeypatch):
        for text, basis in (("Abubakar Musa bought 12% of Kano Flour Mills Plc.", "headline"),
                            ("Abubakar Musa bought 12% of Kano Flour Mills Plc. " * 40, "article")):
            out = tmp_path / basis
            out.mkdir()
            records, rows = run_story(out, monkeypatch, text, self.ANALYSIS)
            assert [r.get("basis") for r in records] == [basis]
            assert [r.get("Basis") for r in rows] == [basis]
