import pytest
from run_pipeline import (
    is_placeholder_person,
    is_publication_or_furniture,
    is_role_or_org_name,
    is_unevidenced_officer,
)


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


# ---------------------------------------------------------------------------
# Placeholder person names
#
# The extractor writes a marker into Name when an article named nobody.
# Those rows shipped as tracked people: the appointments board rendered
# "Unknown left Speaker @ Edo State House of Assembly" with a link to a
# person dossier, and the entity directory listed "Not Specified".
# Observed in the live people.json: Unknown (4), Not Specified (3),
# Not Stated (3), None (1).
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", [
    "Unknown",
    "unknown",
    "UNKNOWN",
    "None",
    "Not Specified",
    "Not Stated",
    "not  stated",          # double space, as scraped
    "Unknown\xa0",          # nbsp, like the Archives rows above
    "N/A",
    "n/a.",
    "(unknown)",
    "nil",
    "TBD",
    "Anonymous",
    "Unnamed",
    "-",
    "--",
    "",
    "   ",
    None,
])
def test_placeholder_person_names_are_dropped(name):
    assert is_placeholder_person(name) is True


@pytest.mark.parametrize("name", [
    "Ada Obi",
    "Bola Tinubu",
    "Timipre Sylva",
    "Comfort Ero",
    "Nancy",                # starts with "n", is not "n/a"
    "Nilesh Patel",         # starts with "nil"
    "Nana Akufo-Addo",      # starts with "na"
    "Tinubu",               # a bare surname is a weak name, not a placeholder
    "Unnamed Commissioner",  # carries the role: kept, rendered without a link
    "Unnamed Nigerian",
])
def test_real_person_names_survive(name):
    assert is_placeholder_person(name) is False


def test_placeholder_guard_runs_over_the_live_shape():
    """The export filter's three guards compose: only real people survive."""
    rows = [
        {"Name": "Ada Obi", "Organization": "Dangote"},
        {"Name": "Unknown", "Organization": "Edo State House of Assembly"},
        {"Name": "Not Specified", "Organization": "Geregu Power"},
        {"Name": "Unnamed Commissioner", "Organization": "Lagos State"},
    ]
    kept = [r for r in rows if not is_placeholder_person(r["Name"])]
    assert [r["Name"] for r in kept] == ["Ada Obi", "Unnamed Commissioner"]


# ---------------------------------------------------------------------------
# Roles and organisations captured where a person belongs
#
# Precision is the whole game: 43% of the moves board is a real person named
# by surname alone ("Cardoso", "Orya", "Agbebaku"), so a rule keyed on how
# thin a name looks would delete most of the board. These key on what the
# name is made of. Over the 440 distinct names in the live people.json the
# guard flags exactly six, all six genuinely not people.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", [
    "Managing Director/Chief Executive",  # the post, not its holder
    "Officers Commanding",
    "Director-General",
    "Acting Chief Executive",
    "Deputy Governor",
    "MD NAN",                             # post + the organisation's initials
    "DG NTA",
    "CEO NNPC",
    "Kogi Forum",                         # an organisation in the Name field
    "Rafa Corporation Accelerates Growth",  # a headline fragment
    "Nigeria Labour Congress",
    "Lagos State University",
])
def test_roles_and_organisations_are_not_people(name):
    assert is_role_or_org_name(name) is True


@pytest.mark.parametrize("name", [
    # Real people on the live board, including the single-token surnames
    # that make up almost half of it.
    "Cardoso",
    "Orya",
    "Agbebaku",
    "Tinubu",
    "Mohammed",
    "Coker-Odusote",
    "Bola Tinubu",
    "Comfort Ero",
    "Timipre Sylva",
    "Is-haq Olanrewaju Oloyede",
    # Titles attached to a real name must survive: only an all-role name goes.
    "Prof Gombe",
    "Capt. Wisdom",
    "Dr Haydar Daudu",
    # Near-misses on the acronym rule: a surname pair is not "MD NAN".
    "Nanna Ama",
    "Ali Isa",
    "Abu Ammar",
    "Uwem Ite",
    "Betta Edu",
])
def test_real_people_survive_the_role_guard(name):
    assert is_role_or_org_name(name) is False


def test_role_guard_is_blank_safe():
    """Blankness is the placeholder guard's job, not this one's."""
    for blank in ["", "   ", None]:
        assert is_role_or_org_name(blank) is False


# ---------------------------------------------------------------------------
# The retired heuristic fallback's fingerprint
#
# It gave every person it found position "Officer" and the article's first
# organisation. Neither was a finding, so a row carrying the bare post has
# an invented Organization too -- "Fayose | Officer | Tinubu" asserts that
# one politician works for another. 332 rows in the live export carry it,
# 93% of July and none since September.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("position", ["Officer", "officer", "  OFFICER  ", "Officer\xa0"])
def test_the_bare_officer_fingerprint_is_recognised(position):
    assert is_unevidenced_officer(position) is True


@pytest.mark.parametrize("position", [
    "Chief Security Officer",     # real posts that merely contain the word
    "Information Officer",
    "Chief Executive Officer",
    "Officers Commanding",
    "President",
    "",
    None,
])
def test_real_posts_containing_officer_survive(position):
    assert is_unevidenced_officer(position) is False


def test_the_fingerprint_discards_the_invented_organisation_with_the_post():
    """Both fields came from the same evidence-free code, so both go."""
    rows = [
        {"Name": "Fayose", "Position": "Officer", "Organization": "Tinubu"},
        {"Name": "Ada Obi", "Position": "Chief Security Officer", "Organization": "Dangote"},
        {"Name": "Ben Ade", "Position": "President", "Organization": "Not Specified"},
    ]
    for row in rows:
        if is_unevidenced_officer(row["Position"]):
            row["Position"] = ""
            row["Organization"] = ""
        elif is_placeholder_person(row["Organization"]):
            row["Organization"] = ""

    assert rows[0] == {"Name": "Fayose", "Position": "", "Organization": ""}
    assert rows[1]["Organization"] == "Dangote", "a real post keeps its organisation"
    assert rows[2] == {"Name": "Ben Ade", "Position": "President", "Organization": ""}
