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
