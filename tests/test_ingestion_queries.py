"""Search topics and feed-chrome filtering.

The pipeline's first search query used to read:

    ("Public Sector Company" OR "PSC Nigeria" OR Parastatal OR ...)

In this product PSC means **Persons with Significant Control** — beneficial
owners under CAMA 2020 — not "public sector company". The pipeline was
therefore trawling for parastatal news and never surfaced a single ownership
disclosure; every daily brief reported "no PSC or beneficial ownership
disclosures present in the dataset". These tests pin the corrected intent.
"""

import pytest

from backend.app.services.ingestion import NewsIngestionService, is_navigation_stub


# --------------------------------------------------------------------------
# Search topics
# --------------------------------------------------------------------------

def test_beneficial_ownership_is_searched_for_explicitly():
    """The product's primary purpose must appear in the search terms."""
    terms = NewsIngestionService.SEARCH_TOPICS["beneficial_ownership"].lower()
    assert "persons with significant control" in terms
    assert "beneficial owner" in terms
    assert "ultimate beneficial owner" in terms


def test_psc_is_not_searched_as_public_sector_company():
    """Regression guard for the mis-expansion that caused the whole problem."""
    joined = " ".join(NewsIngestionService.SEARCH_TOPICS.values()).lower()
    assert "public sector company" not in joined


def test_governance_and_registry_topics_are_covered():
    topics = NewsIngestionService.SEARCH_TOPICS
    assert "corporate_governance" in topics
    assert "corporate_registry" in topics

    governance = topics["corporate_governance"].lower()
    assert "corporate governance" in governance
    assert "board of directors" in governance

    registry = topics["corporate_registry"].lower()
    assert "corporate affairs commission" in registry
    assert "cama" in registry


def test_ownership_topics_lead_the_search_order():
    """Ordering is meaningful: the first topics are the product's purpose."""
    first_two = list(NewsIngestionService.SEARCH_TOPICS)[:2]
    assert first_two == ["beneficial_ownership", "corporate_registry"]


def test_public_sector_is_retained_as_a_secondary_topic():
    """The old focus stays, demoted rather than deleted."""
    assert "public_sector" in NewsIngestionService.SEARCH_TOPICS


def test_build_queries_scopes_every_topic_to_the_site_filter():
    queries = NewsIngestionService.build_queries()
    assert len(queries) == len(NewsIngestionService.SEARCH_TOPICS)
    for q in queries:
        assert "site:premiumtimesng.com" in q
        assert q.startswith("(") and q.endswith(")")


def test_an_explicit_query_overrides_the_topic_list():
    queries = NewsIngestionService.build_queries("Dangote Cement")
    assert len(queries) == 1
    assert "Dangote Cement" in queries[0]
    assert "site:guardian.ng" in queries[0]


# --------------------------------------------------------------------------
# Feed chrome
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "title, source",
    [
        # Real entries returned by the new site-scoped queries.
        ("Corporate Affairs Commission", "Corporate Affairs Commission"),
        ("Corporate Affairs Commission - Corporate Affairs Commission",
         "Corporate Affairs Commission"),
        ("Account Login - Corporate Affairs Commission", "Corporate Affairs Commission"),
        ("NAICOM Home - NAICOM", "NAICOM"),
        ("Home", "Some Agency"),
        ("Contact Us", None),
        ("", None),
        (None, None),
    ],
)
def test_navigation_chrome_is_discarded(title, source):
    assert is_navigation_stub(title, source)


@pytest.mark.parametrize(
    "title, source",
    [
        ("Nigeria's beneficial ownership regime at risk as banks allow inactive companies to run accounts",
         "Premium Times"),
        ("CBN Releases Code of Corporate Governance for Finance Companies in Nigeria", "Proshare"),
        # "register" alone is chrome; these are the stories we exist to find.
        ("CAC opens PSC register to the public", "The Guardian"),
        ("Beneficial ownership register records 40,000 filings", "BusinessDay"),
        ("Company secretary resigns from Access Holdings board", "Nairametrics"),
    ],
)
def test_real_stories_survive_the_chrome_filter(title, source):
    assert not is_navigation_stub(title, source)


def test_a_title_that_merely_contains_the_source_is_kept():
    """Only a title that *is* the publication name is chrome."""
    assert not is_navigation_stub(
        "NAICOM completes recapitalisation exercise for 43 insurance companies", "NAICOM"
    )
