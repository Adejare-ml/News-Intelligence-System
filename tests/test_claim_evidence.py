"""
Evidence for every published ownership claim: the article, a short quote
from text AURA stored about it, the date, and when the export checked it.
The quote is always lifted from stored text, never written for the occasion.
"""
from backend.app.services import register_quality as q

URL = "https://punchng.com/kano-flour/"
ARTICLE = {
    "URL": URL, "Time": "2026-09-30T07:10:00Z", "Title": "Musa raises stake in Kano Flour",
    "Summary": "Flour prices rose in the north. Abubakar Musa now holds 12% of Kano Flour Mills, "
               "filings show. Analysts expect more deals.",
    "Key Facts": "Prices rose 8% in September | Musa bought the shares from Sahel Nominees",
}


def psc(**kw):
    base = {"Person Name": "Alhaji Abubakar Musa", "Company": "Kano Flour Mills Plc",
            "Source URL": URL, "Date": "2026-10-01"}
    base.update(kw)
    return base


class TestQuote:
    def test_prefers_a_sentence_naming_the_person_in_full(self):
        quote = q.evidence_quote([ARTICLE["Key Facts"], ARTICLE["Summary"]],
                                 "Alhaji Abubakar Musa")
        assert quote == "Abubakar Musa now holds 12% of Kano Flour Mills, filings show."

    def test_never_falls_back_to_a_surname_or_the_company(self):
        # A surname or company sentence can be about someone else entirely.
        assert q.evidence_quote([ARTICLE["Key Facts"]], "Abubakar Musa") == ""
        assert q.evidence_quote(["Kano Flour Mills shares jumped."], "Jane Doe") == ""
        facts = "Aliko Dangote sold his 20% stake in Kano Flour Mills. | Sani Dangote was named a director."
        assert q.evidence_quote([facts], "Halima Dangote") == ""

    def test_company_holder_is_matched_on_its_company_name(self):
        text = "Shares in Abuja Ltd fell. Dangote Industries Ltd bought 20% of Kano Flour Mills."
        assert q.evidence_quote([text], "Dangote Industries Ltd") == \
            "Dangote Industries Ltd bought 20% of Kano Flour Mills."
        # 'Ltd' alone is not the holder.
        assert q.evidence_quote(["Shares in Abuja Ltd fell."], "Dangote Industries Ltd") == ""

    def test_sentences_naming_a_withheld_person_are_never_quoted(self):
        text = "Dangote Industries Ltd bought Abubakar Musa's 20% stake in Kano Flour Mills."
        assert q.evidence_quote([text], "Dangote Industries Ltd",
                                withheld=["Abubakar Musa"]) == ""

    def test_key_facts_separators_never_lead_a_quote(self):
        facts = ("Tunji Alausa is the Minister of Education. | The National Library of Nigeria "
                 "headquarters project in Abuja had been long abandoned.")
        assert q.evidence_quote([facts], "National Library of Nigeria") == \
            "The National Library of Nigeria headquarters project in Abuja had been long abandoned."

    def test_no_matching_text_means_no_quote(self):
        assert q.evidence_quote(["Flour prices rose in the north."], "Abubakar Musa") == ""
        assert q.evidence_quote([None, ""], "Abubakar Musa") == ""

    def test_long_sentences_are_cut_at_a_word_to_200_characters(self):
        text = "Abubakar Musa " + "bought more shares again " * 20 + "today."
        quote = q.evidence_quote([text], "Abubakar Musa")
        assert len(quote) <= 200 and quote.endswith("…")
        assert text.startswith(quote[:-1].rstrip())


class TestAttachEvidence:
    def test_each_row_carries_source_quote_date_and_check_time(self):
        out = q.attach_evidence([psc()], [ARTICLE], verified_at="2026-11-07 06:00:00")
        assert out[0]["Evidence"] == {
            "source_url": URL,
            "quote": "Abubakar Musa now holds 12% of Kano Flour Mills, filings show.",
            "date": "2026-09-30",
            "last_verified": "2026-11-07 06:00:00",
        }

    def test_row_without_a_stored_article_keeps_its_own_date_and_no_quote(self):
        out = q.attach_evidence([psc(**{"Source URL": "https://x.ng/a"})], [ARTICLE], verified_at="t")
        assert out[0]["Evidence"] == {"source_url": "https://x.ng/a", "quote": "",
                                      "date": "2026-10-01", "last_verified": "t"}

    def test_feed_dates_become_iso_days(self):
        # Most stored articles carry the feed's RFC-822 time.
        article = dict(ARTICLE, Time="Fri, 06 Nov 2026 17:55:52 GMT")
        assert q.attach_evidence([psc()], [article], verified_at="t")[0]["Evidence"]["date"] == "2026-11-06"
        unreadable = dict(ARTICLE, Time="sometime last week")
        assert q.attach_evidence([psc()], [unreadable], verified_at="t")[0]["Evidence"]["date"] == "2026-10-01"

    def test_a_withheld_persons_claim_never_becomes_another_cards_quote(self):
        article = dict(ARTICLE, **{"Key Facts": "Dangote Industries Ltd and Abubakar Musa sold their "
                                                "Kano Flour Mills shares to a buyer."})
        company_row = psc(**{"Person Name": "Dangote Industries Ltd"})
        out = q.attach_evidence([company_row], [article], verified_at="t", withheld=["Abubakar Musa"])
        assert out[0]["Evidence"]["quote"] == ""

    def test_withheld_names_are_the_people_on_withheld_rows(self):
        checked = q.gate([
            psc(**{"Person Name": "Abubakar Musa", "Previous Holder": "Ada Obi"}),  # headline only
            psc(**{"Person Name": "Halima Bello", "Basis": "article"}),             # published
            psc(**{"Person Name": "Sahel Nominees", "Source URL": ""}),             # unsourced company
        ])
        assert sorted(q.withheld_names(checked)) == ["Abubakar Musa", "Ada Obi"]

    def test_input_rows_are_not_mutated(self):
        rows = [psc()]
        q.attach_evidence(rows, [ARTICLE], verified_at="t")
        assert "Evidence" not in rows[0]
