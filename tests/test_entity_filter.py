import pytest
from run_pipeline import is_publication_or_furniture


@pytest.mark.parametrize("name", [
    "The Guardian Nigeria News",
    "Premium Times Nigeria",
    "Archives\xa0\xa0Premium Times Nigeria",  # observed in graph.json, nbsp-separated
    "Punch Newspapers",
    "Vanguard News",
    "dailypost",
    "Reuters",
    "Archives",
    "Newsletter",
])
def test_publications_and_furniture_are_dropped(name):
    assert is_publication_or_furniture(name) is True


@pytest.mark.parametrize("name", [
    "Dangote Cement Plc",
    "BUA Foods Plc",
    "Nigerian National Petroleum Company",
    "EFCC",
    "CBN",
    "Central Bank of Nigeria",
    "Access Holdings Plc",
    "Bureau of Public Procurement",
])
def test_real_entities_are_kept(name):
    assert is_publication_or_furniture(name) is False


def test_blank_names_are_dropped():
    for blank in ["", "   ", None]:
        assert is_publication_or_furniture(blank) is True


def test_short_agency_acronyms_survive():
    """Length-based filtering would wrongly drop legitimate Nigerian agencies."""
    for acronym in ["NNPC", "NPA", "FIRS", "NERC", "BPE", "NDDC"]:
        assert is_publication_or_furniture(acronym) is False


@pytest.mark.parametrize("name", [
    # "guardian"/"punch"/"vanguard"/"tribune" are ordinary words that also
    # name companies; a bare substring test dropped all of these.
    "Guardian Life Assurance Plc",
    "Industrial Arbitration Tribunal",       # "tribune" must not match "tribunal"
    "The National Pension Commission",       # "the nation" must not match "the national"
    "Vanguard Pensions Limited Trustees",
    "Punch Bowl Events Ltd",
])
def test_companies_sharing_words_with_outlets_survive(name):
    assert is_publication_or_furniture(name) is False


@pytest.mark.parametrize("name", [
    # The actual outlets those words name must still be dropped.
    "The Guardian",
    "Nigerian Tribune",
    "The Nation",
    "ThisDay",
    "This Day Newspaper",
    "Daily Post",
    "BBC News",
    "Thomson Reuters",
])
def test_the_actual_outlets_are_still_dropped(name):
    assert is_publication_or_furniture(name) is True
