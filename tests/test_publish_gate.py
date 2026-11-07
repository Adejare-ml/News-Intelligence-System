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
