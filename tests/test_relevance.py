"""Topical relevance guard.

The pipeline's relevance decision was a single boolean from the language model.
When the model got it wrong — or when the cascade was bypassed entirely, as it
was for every record before the Engine column existed — sports and celebrity
stories were published as corporate intelligence with real risk scores.

These tests pin the deterministic guard that sits behind the model. The
false-positive cases matter more than the true positives: over-filtering
silently loses real ownership signal, which is worse than the noise it removes.
"""

import pytest

from backend.app.services.relevance import is_off_topic, off_topic_reason


# --------------------------------------------------------------------------
# Must be rejected
# --------------------------------------------------------------------------

OFF_TOPIC = [
    # The story that prompted this guard: published at risk 40, category Company.
    "Nigeria's Anichebe set to buy England football club",
    "MLS: Messi returns as Inter Miami draw 2-2 against Columbus Crew",
    "King Ochacho gifts Peller and Jarvis mansion worth hundreds of millions in star-studded wedding",
    "Super Eagles coach names 23-man squad for AFCON qualifier",
    "Osimhen scores twice as Galatasaray beat Besiktas 3-1",
    "Nollywood actress opens up about her new movie role",
    "BBNaija Season 11 housemates face eviction this Sunday",
    "Davido announces new album release date",
    "Chelsea complete signing of midfielder in transfer window",
    "Nigeria beat Ghana 2-0 in international friendly",
    "Wizkid wins Grammy for best global music album",
]


@pytest.mark.parametrize("title", OFF_TOPIC)
def test_sports_and_celebrity_stories_are_rejected(title):
    assert is_off_topic(title), f"should have been filtered: {title!r}"


def test_reason_names_the_topic():
    reason = off_topic_reason("Super Eagles coach names squad for AFCON qualifier")
    assert reason is not None
    assert reason.topic == "sport"
    assert reason.matched, "the matched terms should be reported for auditability"


# --------------------------------------------------------------------------
# Must be kept — these are the expensive mistakes
# --------------------------------------------------------------------------

ON_TOPIC = [
    # Real headlines the pipeline published, all legitimately in scope.
    "10 insurers risk liquidation as 43 scale recapitalisation hurdle",
    "NAICOM completes recapitalisation exercise for 43 insurance companies",
    "MTN Nigeria Clears FX Debt, Unlocks New Investment Phase",
    "Odu'a Investment inaugurates Kasali as Chairman, targets N1tr assets by 2030",
    "Fidson, Nigeria's largest pharmaceutical company, delivers N3.6 billion dividend to shareholders",
    "FirstHoldCo becomes Nigeria's First N6tn banking stock",
    "NNPC posts N2.27tn half-year profit amid oil price rally",
    "Payaza, Lebara Nigeria partner to expand digital payments",
    "EFCC asked to probe alleged N70bn OSOPADEC budget forgery",
    "Cross River unveils US$1.075bn historic PPP investment package",
    "NCDMB, BOI launch $100 million equity fund",
    "Adetu re-appointed as Registrar of KolaDaisi University",
    "CBN lists five strategies to drive next stage of fintech growth",
    "Abandoned projects: Fed Govt bars ministries from awarding unfunded contracts",
    "Senate Threatens Sanctions as CBN, NUPRC, NDDC, Others Shun Public Accounts Committee",
]


@pytest.mark.parametrize("title", ON_TOPIC)
def test_corporate_stories_are_kept(title):
    assert not is_off_topic(title), f"should NOT have been filtered: {title!r}"


# --------------------------------------------------------------------------
# The hard cases: sport or entertainment words inside a genuine corporate story
# --------------------------------------------------------------------------

CORPORATE_DESPITE_SPORT_WORDS = [
    "Dangote acquires 60% stake in football club holding company",
    "MultiChoice discloses beneficial owners of its sports broadcasting subsidiary",
    "SEC approves merger of two sports betting operators",
    "Board of Nigerian football federation sponsor files PSC return with CAC",
    "Investment club acquires 30% shareholding in Lagos logistics firm",
    "GTCO reports record profit from its entertainment lending portfolio",
]


@pytest.mark.parametrize("title", CORPORATE_DESPITE_SPORT_WORDS)
def test_explicit_ownership_language_overrides_the_topic_guard(title):
    """A shareholding story is in scope even when the asset is a football club.

    This is the guard's most important escape hatch: without it, the filter
    would drop exactly the acquisition stories the product exists to track.
    """
    assert not is_off_topic(title), f"ownership language should win: {title!r}"


def test_a_bare_transactional_verb_does_not_override():
    """"Acquisition" alone is not evidence of corporate reporting.

    Regression guard for the exact record that prompted this work: a football
    transfer story whose summary read "pursuing the acquisition of a football
    club" was readmitted at risk 40 under category "Company".
    """
    title = "Nigeria's Anichebe set to buy England football club"
    summary = (
        "Nigerian national Anichebe is reportedly pursuing the acquisition of a "
        "football club in England. The transaction suggests a potential change "
        "in ownership and corporate control of the sports entity."
    )
    assert is_off_topic(title, summary)


def test_a_quantified_transactional_verb_does_override():
    """"Acquires 60%" is a real ownership claim and must survive."""
    assert not is_off_topic("Investor acquires 60% of Lagos football club")
    assert not is_off_topic("Firm completes takeover of 25 per cent of sports agency")


# --------------------------------------------------------------------------
# Robustness
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "title",
    [
        "NBA elects Badejo-Okusanya as new officer",
        "NBA Election: candidates set out governance agenda",
        "Nigerian Bar Association petitions the Corporate Affairs Commission",
    ],
)
def test_nba_is_the_nigerian_bar_association_not_basketball(title):
    """Abbreviations must be read in their Nigerian sense.

    NBA appears 14 times in the live entity table, attached to people recorded
    as officers of the Nigerian Bar Association. Treating it as a sports league
    would drop real professional-body governance coverage — the exact
    false-positive class this guard must avoid.
    """
    assert not is_off_topic(title)


def test_matching_is_word_boundary_not_substring():
    """Substring matching would filter real stories on accidental collisions."""
    # "golf" inside "Golfview Estates", "match" inside "matched", "fc" in "FCMB"
    assert not is_off_topic("Golfview Estates Limited files annual return with CAC")
    assert not is_off_topic("FCMB matched the capital requirement set by CBN")
    assert not is_off_topic("Fixture of the new board announced by the company")


def test_summary_text_is_considered_as_well_as_title():
    """A bland title with sporting content in the body must still be caught.

    Note the title deliberately avoids ownership language — with "acquisition"
    in it the override fires and the article is correctly kept, since a club
    takeover is genuinely in scope. See the override test above.
    """
    title = "Former international completes long-running pursuit"
    summary = "The retired striker beat two other bidders for the Premier League club."
    assert not is_off_topic(title)
    assert is_off_topic(title, summary)


@pytest.mark.parametrize("value", [None, "", "   ", 123, [], {}])
def test_malformed_input_never_raises_and_never_filters(value):
    """A guard that throws would take the whole pipeline run down."""
    assert is_off_topic(value) is False


def test_single_weak_signal_alone_does_not_filter():
    """One ambiguous word is not evidence; the guard needs a real signal."""
    assert not is_off_topic("Company appoints new coach for its graduate trainee scheme")
