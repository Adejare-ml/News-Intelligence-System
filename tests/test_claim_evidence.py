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
                                 "Alhaji Abubakar Musa", "Kano Flour Mills Plc")
        assert quote == "Abubakar Musa now holds 12% of Kano Flour Mills, filings show."

    def test_falls_back_to_the_surname_then_the_company(self):
        assert q.evidence_quote([ARTICLE["Key Facts"]], "Abubakar Musa", "X") == \
            "Musa bought the shares from Sahel Nominees"
        assert q.evidence_quote(["Kano Flour Mills shares jumped."], "Jane Doe", "Kano Flour Mills Plc") == \
            "Kano Flour Mills shares jumped."

    def test_no_matching_text_means_no_quote(self):
        assert q.evidence_quote(["Flour prices rose in the north."], "Abubakar Musa", "Kano Flour") == ""
        assert q.evidence_quote([None, ""], "Abubakar Musa", "Kano Flour") == ""

    def test_long_sentences_are_cut_at_a_word_to_200_characters(self):
        text = "Abubakar Musa " + "bought more shares again " * 20 + "today."
        quote = q.evidence_quote([text], "Abubakar Musa", "Kano Flour")
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

    def test_input_rows_are_not_mutated(self):
        rows = [psc()]
        q.attach_evidence(rows, [ARTICLE], verified_at="t")
        assert "Evidence" not in rows[0]
