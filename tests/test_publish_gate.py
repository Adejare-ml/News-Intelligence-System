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
            row(Basis="filing"),
            row(Basis="article"),
            row(Basis="headline", Approved="yes"),
            row(),
        )]
        assert tiers == ["Official filing", "Official filing", "Full article",
                         "Headline only", "Headline only"]


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
