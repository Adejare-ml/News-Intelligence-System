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
    assert back == {"key_facts": ["A paid N5bn", "B won"], "why_it_matters": "Matters."}


def test_a_pipe_inside_a_fact_cannot_split_it_later():
    cells = sd.article_cells({"key_facts": ["Rate | spread widened"]})
    assert sd.from_row(cells)["key_facts"] == ["Rate / spread widened"]


def test_missing_fields_are_empty_not_none():
    assert sd.article_cells({}) == {"Key Facts": "", "Why It Matters": ""}
    assert sd.from_row({}) == {"key_facts": [], "why_it_matters": ""}
