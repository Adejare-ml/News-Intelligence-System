"""
The extraction metric must be trustworthy before any optimiser runs against it.

GEPA optimises exactly what this file measures and nothing else, so these tests
are less about the metric being "correct" than about it being *unexploitable* on
the three failures that matter: inventing a percentage, listing the newspaper as
a party to the story, and publishing off-topic coverage as relevant.

No network and no model: everything here is plain data in, score out.
"""
import pytest

from evals.metric import extraction_metric, SCORE_TOLERANCE


def score_and_feedback(gold, pred):
    result = extraction_metric(gold, pred)
    if isinstance(result, tuple):
        return result
    return result.score, result.feedback


ARTICLE = (
    "Femi Otedola has increased his shareholding in First HoldCo, according to a "
    "filing seen on Monday. The transaction was disclosed to the exchange."
)


def base_gold(**over):
    gold = {
        "title": "Otedola increases stake in First HoldCo",
        "article_text": ARTICLE,
        "relevant": True,
        "category": "Company",
        "event_type": "Ownership Change",
        "risk_level": "High",
        "risk_score": 70,
        "importance_score": 75,
        "organizations": [{"name": "First HoldCo", "type": "company"}],
        "people": [],
        "significant_control": [{"name": "Femi Otedola", "organization": "First HoldCo"}],
    }
    gold.update(over)
    return gold


def base_pred(**over):
    pred = {k: v for k, v in base_gold().items() if k not in ("title", "article_text")}
    pred.update(over)
    return pred


# --- the three disqualifying failures ---------------------------------------

def test_fabricated_percentage_scores_zero():
    """The article states no figure, so any percentage is invented."""
    pred = base_pred(significant_control=[
        {"name": "Femi Otedola", "organization": "First HoldCo", "percentage": "31%"}
    ])
    score, feedback = score_and_feedback(base_gold(), pred)
    assert score == 0.0
    assert "Fabricated" in feedback
    assert "31%" in feedback


def test_percentage_actually_present_in_the_article_is_accepted():
    text = ARTICLE + " His holding now stands at 31%."
    gold = base_gold(article_text=text)
    pred = base_pred(significant_control=[
        {"name": "Femi Otedola", "organization": "First HoldCo", "percentage": "31%"}
    ])
    score, _ = score_and_feedback(gold, pred)
    assert score == 1.0


def test_indirect_percentage_is_checked_too():
    pred = base_pred(significant_control=[
        {"name": "Femi Otedola", "organization": "First HoldCo", "indirect_percentage": "12.5%"}
    ])
    score, feedback = score_and_feedback(base_gold(), pred)
    assert score == 0.0
    assert "indirect_percentage" in feedback


def test_publication_listed_as_organization_scores_zero():
    pred = base_pred(organizations=[
        {"name": "First HoldCo", "type": "company"},
        {"name": "Premium Times", "type": "company"},
    ])
    score, feedback = score_and_feedback(base_gold(), pred)
    assert score == 0.0
    assert "Premium Times" in feedback


def test_page_furniture_listed_as_organization_scores_zero():
    pred = base_pred(organizations=[{"name": "Archives", "type": "company"}])
    score, _ = score_and_feedback(base_gold(), pred)
    assert score == 0.0


def test_off_topic_marked_relevant_scores_zero():
    gold = base_gold(title="Super Eagles beat Ghana 2-1 in Lagos friendly", relevant=False)
    pred = base_pred(relevant=True, summary="Super Eagles beat Ghana 2-1")
    score, feedback = score_and_feedback(gold, pred)
    assert score == 0.0
    assert "sport" in feedback.lower()


# --- the relevance gate ------------------------------------------------------

def test_wrong_relevance_scores_zero_however_good_the_rest_is():
    score, feedback = score_and_feedback(base_gold(), base_pred(relevant=False))
    assert score == 0.0
    assert "Relevance is wrong" in feedback


def test_agreeing_an_article_is_irrelevant_scores_one():
    gold = base_gold(relevant=False, title="Company announces quarterly results")
    score, _ = score_and_feedback(gold, base_pred(relevant=False))
    assert score == 1.0


# --- ordinary accuracy -------------------------------------------------------

def test_exact_match_scores_one():
    score, feedback = score_and_feedback(base_gold(), base_pred())
    assert score == 1.0
    assert feedback == "Extraction is correct."


def test_missing_psc_holder_costs_the_most():
    """significant_control carries the heaviest weight; it is what the register uses."""
    missing_psc, _ = score_and_feedback(base_gold(), base_pred(significant_control=[]))
    wrong_cat, _ = score_and_feedback(base_gold(), base_pred(category="Government"))
    assert missing_psc < wrong_cat < 1.0


def test_numeric_scores_inside_the_tolerance_band_are_not_penalised():
    near = base_pred(risk_score=70 + SCORE_TOLERANCE)
    far = base_pred(risk_score=70 + SCORE_TOLERANCE + 1)
    assert score_and_feedback(base_gold(), near)[0] == 1.0
    assert score_and_feedback(base_gold(), far)[0] < 1.0


def test_psc_holder_duplicated_into_people_is_penalised():
    pred = base_pred(people=[{"name": "Femi Otedola", "organization": "First HoldCo",
                              "position": "Investor", "event": "other"}])
    score, feedback = score_and_feedback(base_gold(), pred)
    assert score < 1.0
    assert "belongs only in significant_control" in feedback


def test_feedback_is_always_actionable_text():
    """GEPA reflects on this string, so it must never be empty."""
    for pred in (base_pred(), base_pred(relevant=False), base_pred(category="Legal")):
        _, feedback = score_and_feedback(base_gold(), pred)
        assert isinstance(feedback, str) and len(feedback) > 20


def test_matching_is_insensitive_to_case_and_spacing():
    pred = base_pred(
        organizations=[{"name": "  FIRST HOLDCO ", "type": "Company"}],
        significant_control=[{"name": "femi  otedola", "organization": "First HoldCo"}],
    )
    assert score_and_feedback(base_gold(), pred)[0] == 1.0
