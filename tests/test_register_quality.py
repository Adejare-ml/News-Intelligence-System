"""
The validation gate between the database and the published site. Cases are
taken from rows the live export actually shipped.
"""
from backend.app.services import register_quality as q


def row(**kw):
    base = {
        "Person Name": "Femi Otedola", "Company": "First HoldCo", "Percentage": "",
        "Board Role": "", "Nature of Control": "Ownership of shares",
        "Source": "extracted", "Date": "2026-08-07", "Intermediate Entities": "Direct Holding",
        "Regulatory Filing Ref": "", "Source URL": "https://punchng.com/otedola-firstholdco/",
    }
    # The older tests mark a row unsourced with Source=""; that now means no link too.
    if kw.get("Source") == "" and "Source URL" not in kw:
        kw["Source URL"] = ""
    base.update(kw)
    return base


class TestCanonicalNames:
    def test_honorific_dropped(self):
        assert q.canonical_person("Alhaji Aliko Dangote") == q.canonical_person("Aliko Dangote") == "aliko dangote"

    def test_middle_initial_dropped(self):
        assert q.canonical_person("Tony O. Elumelu") == "tony elumelu"

    def test_accent_folded(self):
        assert q.canonical_person("Sadio Mané") == "sadio mane"

    def test_two_word_name_keeps_both_words(self):
        assert q.canonical_person("Okunbor") == "okunbor"
        assert q.canonical_person("Jim Ovia") == "jim ovia"

    def test_company_variants_share_a_key(self):
        assert q.canonical_company("Dangote Petroleum Refinery") == q.canonical_company("Dangote Refinery")
        assert q.canonical_company("FirstHoldCo") == q.canonical_company("First HoldCo")

    def test_company_suffix_dropped(self):
        assert q.canonical_company("Dangote Cement Plc") == "dangote cement"
        assert q.canonical_company("United Bank for Africa (UBA) Plc") == "united bank for africa"
        assert q.canonical_company("AA Oil Limited") == "aa oil"


class TestClassify:
    def test_percentage_is_a_stake(self):
        assert q.classify_row(row(Percentage="27.49%")) == "stake"

    def test_shares_without_percentage_is_still_a_stake(self):
        assert q.classify_row(row()) == "stake"

    def test_chairman_without_stake_is_a_role(self):
        r = row(**{"Board Role": "Chairman", "Nature of Control": "Significant influence or control"})
        assert q.classify_row(r) == "role"

    def test_bare_influence(self):
        assert q.classify_row(row(**{"Nature of Control": "Significant influence or control"})) == "influence"


class TestQualityFlags:
    def test_unsourced(self):
        assert "unsourced" in q.quality_flags(row(Source=""))
        assert "unsourced" not in q.quality_flags(row())

    def test_sports_figure_is_implausible(self):
        assert "implausible" in q.quality_flags(row(**{"Person Name": "Sadio Mané", "Company": "Mango Business"}))

    def test_percentage_out_of_range_is_implausible(self):
        assert "implausible" in q.quality_flags(row(Percentage="140%"))

    def test_ordinary_row_is_plausible(self):
        assert "implausible" not in q.quality_flags(row(Percentage="27.49%"))


class TestAnnotate:
    def test_adds_fields_and_keeps_every_row(self):
        rows = [row(), row(**{"Person Name": "Sadio Mané", "Company": "Mango Business"}), row(Source="")]
        out = q.annotate(rows)
        assert len(out) == 3
        assert out[0]["Person Key"] == "femi otedola" and out[0]["Kind"] == "stake"
        assert out[1]["Quarantined"] is True
        assert out[2]["Quality"][0] == "unsourced"
        assert "Person Key" not in rows[0], "input rows must not be mutated"

    def test_null_board_role_blanked(self):
        assert q.annotate([row(**{"Board Role": "null"})])[0]["Board Role"] == ""

    def test_spelling_variants_of_one_report_collapse(self):
        a = row(Company="First HoldCo", Date="2026-08-05")
        b = row(Company="FirstHoldCo", Date="2026-08-05")
        c = row(Company="First HoldCo", Date="2026-08-11")
        assert len(q.collapse_same_report(q.annotate([a, b, c]))) == 2


class TestProcurement:
    def p(self, **kw):
        base = {"Agency": "Ogun State Government", "Contractor": "DP World", "Amount": "$7 Billion",
                "Project": "", "Source": "", "Date": "2026-09-25",
                "Amount Value": 7e9, "Amount Currency": "USD"}
        base.update(kw)
        return base

    def test_same_award_from_several_outlets_kept_once(self):
        rows = [self.p(), self.p(Date="2026-09-26"), self.p(Project="Port expansion", Date="2026-09-26")]
        out = q.dedupe_procurement(rows)
        assert len(out) == 1
        assert out[0]["Project"] == "Port expansion", "the fullest row wins"

    def test_unidentified_rows_are_not_merged(self):
        blank = {"Agency": "Federal Government of Nigeria", "Contractor": "None", "Amount Value": None}
        assert len(q.dedupe_procurement([blank, dict(blank)])) == 2

    def test_no_amount_merges_only_on_same_date(self):
        a = self.p(Contractor="Hitech Construction", **{"Amount Value": None, "Date": "2026-10-05"})
        b = dict(a, Contractor="Hitech Construction Company")
        c = dict(a, Date="2026-11-01")
        assert len(q.dedupe_procurement([a, b, c])) == 2


class TestProcurementAcrossSpellings:
    def p(self, **kw):
        base = {"Agency": "Federal Government of Nigeria", "Contractor": "None", "Amount": "",
                "Project": "", "Source": "", "Date": "", "Amount Value": 1.5e12, "Amount Currency": "NGN"}
        base.update(kw)
        return base

    def test_same_value_and_project_under_another_agency_merges(self):
        rows = [self.p(Agency="Bureau of Public Procurement", Project="procurement reforms and benchmarking"),
                self.p(Project="procurement reforms")]
        assert len(q.dedupe_procurement(rows)) == 1

    def test_same_value_same_agency_different_wording_merges(self):
        rows = [self.p(**{"Amount Value": 40.7e9, "Project": "Funding for primary healthcare expansion"}),
                self.p(**{"Amount Value": 40.7e9, "Contractor": "Primary Health Care centers",
                          "Project": "Boost service delivery to Primary Health Care centers"})]
        assert len(q.dedupe_procurement(rows)) == 1

    def test_two_named_contractors_never_merge(self):
        rows = [self.p(Agency="Ogun State Government", Contractor="DP World", Project="Deep seaport",
                       **{"Amount Value": 7e9, "Amount Currency": "USD"}),
                self.p(Agency="Ogun State Government", Contractor="NNPCL", Project="Olokola port",
                       **{"Amount Value": 7e9, "Amount Currency": "USD"})]
        assert len(q.dedupe_procurement(rows)) == 2

    def test_same_value_unrelated_awards_stay_apart(self):
        rows = [self.p(Agency="Oyo State Government", Project="Amotekun projects", **{"Amount Value": 3e9}),
                self.p(Agency="Ekiti State Government", Project="New high court complex", **{"Amount Value": 3e9})]
        assert len(q.dedupe_procurement(rows)) == 2


URL = "https://news.google.com/rss/articles/abc?oc=5"
REC = {
    "url": URL,
    "title": "FAAN begins earning MMA2 revenue as 20-year dispute with Bi-Courtney ends - Premium Times Nigeria",
    "source": "Premium Times Nigeria",
    "analysis": {"summary": "The Federal Airports Authority of Nigeria (FAAN) has begun receiving revenue from the MMA2 terminal. More detail."},
}


class TestBriefHeadlines:
    def test_invented_name_replaced_by_source_title(self):
        md = f"### Key Developments\n- **Georgia’s FCAU receives MMA2 revenue** after a dispute. ([Premium Times Nigeria]({URL}))  "
        out = q.qa_brief_headlines(md, [REC])
        assert "Georgia" not in out and "FCAU" not in out
        assert "**FAAN begins earning MMA2 revenue as 20-year dispute with Bi-Courtney ends**." in out
        assert "Premium Times Nigeria -" not in out
        assert f"({URL}))" in out

    def test_faithful_headline_untouched(self):
        md = f"- **FAAN starts earning MMA2 revenue** after the dispute. ([Premium Times Nigeria]({URL}))  "
        assert q.qa_brief_headlines(md, [REC]) == md

    def test_repeat_in_same_section_dropped(self):
        line = f"- **FAAN starts earning MMA2 revenue** x. ([P]({URL}))"
        md = "### A\n" + line + "\n" + line + "\n### B\n" + line
        assert q.qa_brief_headlines(md, [REC]).count(URL) == 2

    def test_label_bullets_and_unknown_urls_untouched(self):
        md = (f"- **Procurement**: Georgia awarded a deal. ([P]({URL}))\n"
              "- **Georgia wins** x. ([P](https://example.com/other))")
        assert q.qa_brief_headlines(md, [REC]) == md


class TestPublicExport:
    def test_unsourced_and_quarantined_rows_are_not_published(self):
        rows = q.gate([
            row(Percentage="27.49%"),
            row(**{"Person Name": "Jubril Adewale Tinubu", "Company": "Oando Plc", "Percentage": "66.7%", "Source": ""}),
            row(**{"Person Name": "Sadio Mané", "Company": "Mango Business"}),
        ])
        published = q.public_rows(rows)
        assert [r["Person Name"] for r in published] == ["Femi Otedola"]
        assert published[0]["Public"] is True

    def test_withheld_summary_counts_without_names(self):
        rows = q.gate([row(), row(Source="", Date="2026-01-15"), row(**{"Person Name": "Sadio Mané"})])
        summary = q.withheld_summary(rows)
        assert summary == {"checked": 3, "published": 1, "unsourced": 1, "implausible": 1}
        assert "Sadio" not in str(summary)

    def test_unannotated_rows_are_judged_too(self):
        assert q.is_public(row()) is True
        assert q.is_public(row(Source="")) is False


class TestSourceLink:
    def test_extracted_label_is_not_a_source(self):
        # Every row the live export shipped said Source="extracted" and had no link.
        assert "unsourced" in q.quality_flags(row(**{"Source URL": ""}))
        assert q.is_public(q.annotate([row(**{"Source URL": ""})])[0]) is False

    def test_link_makes_it_sourced(self):
        assert "unsourced" not in q.quality_flags(row(Source="extracted"))

    def test_backfill_attaches_the_one_matching_article(self):
        articles = [
            {"URL": "https://punchng.com/a/", "Title": "Otedola raises stake in First HoldCo", "Source": "The Punch", "Summary": ""},
            {"URL": "https://punchng.com/b/", "Title": "Dangote refinery output rises", "Source": "The Punch", "Summary": ""},
        ]
        out = q.backfill_sources([row(**{"Source URL": ""})], articles)
        assert out[0]["Source URL"] == "https://punchng.com/a/"
        assert out[0]["Publisher"] == "The Punch"

    def test_backfill_leaves_ambiguous_rows_unlinked(self):
        articles = [
            {"URL": "https://a.ng/1", "Title": "Femi Otedola and First HoldCo", "Source": "A"},
            {"URL": "https://b.ng/2", "Title": "First HoldCo: Femi Otedola again", "Source": "B"},
        ]
        assert q.backfill_sources([row(**{"Source URL": ""})], articles)[0]["Source URL"] == ""

    def test_backfill_needs_both_names(self):
        articles = [{"URL": "https://a.ng/1", "Title": "Femi Otedola buys a house", "Source": "A"}]
        assert q.backfill_sources([row(**{"Source URL": ""})], articles)[0]["Source URL"] == ""


def rec(url, title, risk="Medium", source="The Punch", summary=""):
    return {"url": url, "title": title, "source": source, "analysis": {"risk_level": risk, "summary": summary}}


class TestCleanBrief:
    RECS = [
        rec("https://punchng.com/seplat/", "Seplat names Effiong Okon as CEO", "Medium", "Premium Times"),
        rec("https://punchng.com/efcc/", "EFCC arrests Abuja businessman over $120m fraud", "High"),
        rec("https://punchng.com/taraba/", "Taraba mining extortion claims", "Medium", "The Guardian"),
        rec("https://vanguardngr.com/nimasa/", "NIMASA seizes four vessels for Cabotage Act breaches", "Medium", "Vanguard News"),
        rec("https://punchng.com/osimhen/", "Osimhen scores twice for Napoli", "Low"),
    ]

    def test_source_tag_becomes_a_link(self):
        md = "### Key Developments\n* NIMASA seized four vessels for Cabotage Act violations ({source: Vanguard News})."
        out = q.clean_brief(md, self.RECS)
        assert "{source" not in out
        assert "([Vanguard News](https://vanguardngr.com/nimasa/))" in out

    def test_uncited_bullet_is_dropped(self):
        md = "### Key Developments\n* Something nobody reported happened in Lagos today."
        assert "nobody reported" not in q.clean_brief(md, self.RECS)

    def test_alerts_keep_only_high_risk(self):
        md = ("### High Risk Alerts\n"
              "* The EFCC arrested a businessman ([The Punch](https://punchng.com/efcc/)).\n"
              "* Taraba mining extortion is a medium-risk concern ([The Guardian](https://punchng.com/taraba/)).")
        out = q.clean_brief(md, self.RECS)
        assert "EFCC" in out and "Taraba" not in out

    def test_story_not_repeated_under_key_developments(self):
        md = ("### Key Developments\n"
              "* Seplat named a new CEO ([Premium Times](https://punchng.com/seplat/)).\n"
              "* The EFCC arrested a businessman ([The Punch](https://punchng.com/efcc/)).\n"
              "### High Risk Alerts\n"
              "* The EFCC arrested a businessman ([The Punch](https://punchng.com/efcc/)).")
        out = q.clean_brief(md, self.RECS)
        assert out.count("punchng.com/efcc/") == 1
        assert out.index("High Risk Alerts") < out.index("punchng.com/efcc/")
        assert "punchng.com/seplat/" in out

    def test_sport_is_dropped(self):
        md = "### Key Developments\n* Osimhen scored twice for Napoli ([The Punch](https://punchng.com/osimhen/))."
        assert "Osimhen" not in q.clean_brief(md, self.RECS)

    def test_headings_and_paragraphs_survive(self):
        md = "### Beneficial Ownership & PSC Disclosures\n\nNo PSC disclosures were reported."
        out = q.clean_brief(md, self.RECS)
        assert "### Beneficial Ownership" in out and "No PSC disclosures" in out
