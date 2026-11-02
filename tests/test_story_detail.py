"""Per-story detail read from the full article for the Morning Brief email."""
from backend.app.services import story_detail as sd


def test_facts_are_cleaned_capped_and_deduplicated():
    facts = sd.clean_facts(
        ["OPay raised $304m", " OPay raised $304m. ", "null", "", "Valued at $4bn", "Listed on NYSE", "Fifth", "Sixth"],
        summary="",
    )
    assert facts == ["OPay raised $304m", "Valued at $4bn", "Listed on NYSE", "Fifth"]


def test_fact_repeating_the_summary_is_dropped():
    assert sd.clean_facts(["OPay listed on the NYSE."], summary="OPay listed on the NYSE") == []


def test_long_fact_is_cut_at_a_word():
    fact = sd.clean_facts(["word " * 80])[0]
    assert len(fact) <= sd.MAX_FACT_CHARS + 1 and fact.endswith("…")


def test_cells_round_trip_through_the_sheet():
    cells = sd.article_cells({"summary": "s", "key_facts": ["A paid N5bn", "B won"], "why_it_matters": "  Matters.  "})
    assert cells == {"Key Facts": "A paid N5bn | B won", "Why It Matters": "Matters."}
    back = sd.from_row({"Summary": "s", **cells})
    assert back == {"key_facts": ["A paid N5bn", "B won"], "why_it_matters": "Matters.", "detail": ""}


def test_a_pipe_inside_a_fact_cannot_split_it_later():
    cells = sd.article_cells({"key_facts": ["Rate | spread widened"]})
    assert sd.from_row(cells)["key_facts"] == ["Rate / spread widened"]


ARTICLE = ("Oyo State Governor Seyi Makinde has approved N4.6 billion as compensation for owners of 1,200 "
           "properties affected by the Circular road project, the government said on Friday.")


def test_facts_with_invented_figures_or_names_are_dropped():
    cells = sd.article_cells({"key_facts": [
        "Makinde approved N4.6 billion in compensation",      # in the text
        "1,200 properties are affected",                      # in the text, comma form
        "The payout is N5.2 billion",                         # invented figure
        "Commissioner Adeyemi will oversee payments",          # invented name
    ]}, ARTICLE, "Makinde approves N4.6bn compensation")
    assert cells["Key Facts"] == "Makinde approved N4.6 billion in compensation | 1,200 properties are affected"


def test_unattributed_accusation_is_dropped():
    cells = sd.article_cells({"why_it_matters": "The payout shows fraud in Oyo's road budget."}, ARTICLE)
    assert cells["Why It Matters"] == ""
    ok = sd.article_cells({"why_it_matters": "A large state payout to Circular road property owners."}, ARTICLE)
    assert ok["Why It Matters"].startswith("A large state payout")


def test_detail_level_reflects_what_was_read():
    assert sd.article_cells({}, "Headline - Premium Times", "Headline", "Premium Times")["Detail"] == "headline"
    assert sd.detail_level("x " * 400) == "snippet"
    assert sd.detail_level("word " * 400) == "full"
    assert sd.from_row({"Detail": "full"})["detail"] == "full"
    assert sd.from_row({"Detail": "nonsense"})["detail"] == ""


def test_missing_fields_are_empty_not_none():
    assert sd.article_cells({}) == {"Key Facts": "", "Why It Matters": ""}
    assert sd.from_row({}) == {"key_facts": [], "why_it_matters": "", "detail": ""}
