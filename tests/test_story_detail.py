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


# --- review findings: accusations, legal steps and reversals ---------------------------

import pytest  # noqa: E402

CHARGE = ("EFCC arraigns Adebayo Somefun over alleged ₦2bn misappropriation at NSITF; "
          "he pleaded not guilty, the commission said.")


@pytest.mark.parametrize("fact", [
    "Makinde misappropriated N4.6 billion meant for Circular road owners",
    "Makinde siphoned N4.6 billion from the Circular road fund",
    "Makinde was arrested over the N4.6 billion Circular road payout",
    "Makinde was convicted over the Circular road compensation",
])
def test_invented_accusations_and_legal_steps_are_dropped(fact):
    assert sd.article_cells({"key_facts": [fact]}, ARTICLE)["Key Facts"] == ""


def test_an_accusation_needs_attribution_even_when_the_article_has_the_word():
    source = "The EFCC alleged fraud by Makinde. A report was filed."
    assert not sd.careful("The N4.6 billion report proves Makinde committed fraud", source)
    assert sd.careful("Makinde committed fraud, the EFCC alleged.", source)


@pytest.mark.parametrize("line, source", [
    ("Senator Musa admitted receiving ₦500m.", "Senator Musa denies receiving ₦500m from NDDC contractor"),
    ("Police charged the cashier over the missing ₦40m.", "Police say the cashier has not been charged over missing ₦40m"),
    ("Somefun pleaded guilty to misappropriating ₦2bn, EFCC said.", CHARGE),
    ("FG scrapped the rail contract.", "FG postpones signing of rail contract"),
])
def test_flipped_meaning_is_dropped(line, source):
    assert not sd.careful(line, source)


def test_the_same_sense_passes():
    assert sd.careful("Somefun pleaded not guilty, EFCC said.", CHARGE)
    assert sd.careful("FG postponed signing the rail contract.", "FG postpones signing of rail contract")


@pytest.mark.parametrize("fact, source", [
    ("Headline inflation eased to 32.70 per cent in September 2026",
     "Headline inflation eased to 32.70 per cent in September 2026, the NBS said."),
    ("Access Holdings will buy a 51% stake in Union Bank", "Access Holdings will buy a 51% stake in Union Bank."),
    ("Access Holdings will sell its pension unit", "Access Holdings will sell its pension unit."),
    ("Army destroys 20 illegal refineries", "The Army said troops destroyed 20 illegal refineries in Rivers."),
])
def test_benign_business_facts_survive(fact, source):
    assert sd.article_cells({"key_facts": [fact]}, source)["Key Facts"] == fact


def test_calling_a_named_firm_illegal_needs_attribution():
    source = "The Army said troops destroyed 20 illegal refineries run by Acme Ltd."
    assert not sd.careful("Acme Ltd ran 20 illegal refineries", source)
    assert sd.careful("Acme Ltd ran 20 illegal refineries, the Army said", source)


def test_investment_advice_is_dropped():
    assert not sd.careful("Investors should buy OPay shares", "OPay shares")


@pytest.mark.parametrize("line, ok", [
    ("Makinde approved N4.6 billion in compensation", True),
    ("Makinde approved ₦4,600 million in compensation", True),
    ("Makinde approved ₦4.6 trillion in compensation", False),   # scale
    ("Makinde approved N4.6 million in compensation", False),    # scale
    ("Makinde approved $4.6bn in compensation", False),          # currency
])
def test_figures_keep_their_currency_and_scale(line, ok):
    assert sd.grounded(line, ARTICLE) is ok


def test_counts_written_as_words_are_compared():
    assert not sd.grounded("EFCC arraigned seven directors", "EFCC arraigned five directors")
    assert sd.grounded("EFCC arraigned five directors", "EFCC arraigned 5 directors")


# --- second review round ------------------------------------------------------------------

def test_a_key_fact_must_restate_one_sentence():
    source = "Senator Musa denies receiving ₦500m from an NDDC contractor. The contractor declined to comment."
    assert sd.article_cells({"key_facts": ["Senator Musa received ₦500m from an NDDC contractor"]}, source)["Key Facts"] == ""
    assert sd.article_cells({"key_facts": ["Senator Musa denies receiving ₦500m from an NDDC contractor"]},
                            source)["Key Facts"] != ""


def test_a_clearance_cannot_become_an_accusation():
    source = "A House panel clears Okunbor of corruption allegations over the oil contract."
    assert sd.article_cells({"key_facts": ["Okunbor faces corruption allegations over the oil contract"]}, source)["Key Facts"] == ""


def test_future_or_conditional_legal_steps_stay_so():
    assert not sd.careful("Okafor was charged with fraud, EFCC said.", "EFCC said Okafor will be charged with fraud.")
    assert not sd.careful("Okafor was found guilty, the court said.", "If found guilty, Okafor faces ten years, the court said.")


def test_parties_keep_their_roles():
    source = "Zenith Bank sues Acme Ltd over a ₦2bn debt."
    assert sd.careful("Zenith Bank sued Acme Ltd over a ₦2bn debt.", source)
    assert not sd.careful("Acme Ltd sued Zenith Bank over a ₦2bn debt.", source)


def test_trillions_in_house_style():
    assert ("NGN", sd.Decimal("1.2E+12")) in sd.amounts_in("Zenith posts N1.2tr profit")
    assert sd.grounded("Zenith posted ₦1.2 trillion profit", "Zenith posts N1.2tr profit")


# --- third round: wording a reader should never see ---------------------------------------

@pytest.mark.parametrize("raw, clean", [
    ("The Anambra State government has sealed an orphanage, though the specific reasons for the action were not "
     "detailed in the provided text.", "The Anambra State government has sealed an orphanage."),
    ("The article discusses a draft Nigeria Economic Policy Framework.", ""),
    ("MTN Nigeria reported a 55% increase in profit. The report does not mention dividends.",
     "MTN Nigeria reported a 55% increase in profit."),
    ("Shareholders approved the report and accounts for 2025.", "Shareholders approved the report and accounts for 2025."),
])
def test_summaries_report_the_news_not_the_text(raw, clean):
    assert sd.clean_summary(raw) == clean


def test_insinuations_need_attribution():
    source = "EXPOSED: Lagos Councillor firm lands N21.35m govt contract barely 7 months after CAC registration"
    assert not sd.careful("This suggests potential conflict of interest and procurement irregularities.", source)


def test_source_sentence_is_the_one_sentence_a_line_restates():
    source = "Shares rose. OPay raised $304m from SoftBank on Friday. It plans to expand."
    assert sd.source_sentence("OPay raised $304m from SoftBank", source) == "OPay raised $304m from SoftBank on Friday."
    assert sd.source_sentence("OPay did not raise $304m from SoftBank", source) == ""
    assert sd.source_sentence("Zenith appointed a chairman", source) == ""
