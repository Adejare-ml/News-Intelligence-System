"""
The typed extraction program, exercised with a stubbed LM.

No API key and no tokens: DummyLM returns canned structured answers, so these
run in CI exactly as they do locally. What is being checked is the contract the
rest of the pipeline depends on -- typed parsing, the legacy dict shape, the
rules an optimiser must not be able to remove, and the promise that a missing
GEPA artifact degrades rather than fails.
"""
import json

import pytest

dspy = pytest.importorskip("dspy")
from dspy.utils.dummies import DummyLM  # noqa: E402

from backend.app.services.dspy_extract import (  # noqa: E402
    PINNED_RULES,
    ExtractIntelligence,
    IntelligenceExtractor,
    load_extractor,
    prediction_to_dict,
)

FULL_ANSWER = {
    "relevant": True,
    "category": "Company",
    "event_type": "PSC Change",
    "risk_score": 72,
    "risk_level": "High",
    "importance_score": 80,
    "summary": "Otedola increased his holding in First HoldCo.",
    "organizations": [{"name": "First HoldCo", "type": "company"}],
    "people": [],
    "significant_control": [{
        "name": "Femi Otedola",
        "organization": "First HoldCo",
        "nature_of_control": "Ownership of shares >25%",
        "change_type": "gained",
        "pep_status": "No",
        "risk_level": "Elevated",
    }],
    "procurement": None,
}


@pytest.fixture
def stub_lm():
    dspy.configure(lm=DummyLM([FULL_ANSWER]))
    yield


def test_typed_fields_parse_into_python_types(stub_lm):
    pred = IntelligenceExtractor()(title="Otedola ups stake", article_text="body")
    assert pred.relevant is True
    assert pred.category == "Company"
    assert isinstance(pred.risk_score, int)
    assert pred.significant_control[0].name == "Femi Otedola"


def test_unstated_percentage_stays_null_rather_than_being_invented(stub_lm):
    """
    The model omitted every percentage field. They must come back as None, not
    as a plausible-looking number and not as a missing key.
    """
    pred = IntelligenceExtractor()(title="t", article_text="b")
    holder = pred.significant_control[0]
    assert holder.percentage is None
    assert holder.direct_percentage is None
    assert holder.indirect_percentage is None


def test_prediction_converts_to_the_legacy_pipeline_shape(stub_lm):
    pred = IntelligenceExtractor()(title="t", article_text="b")
    data = prediction_to_dict(pred)

    # run_pipeline and the Sheets writer read exactly these keys.
    for key in ("relevant", "category", "event_type", "risk_score", "risk_level",
                "importance_score", "summary", "organizations", "people",
                "significant_control", "procurement"):
        assert key in data

    assert isinstance(data["significant_control"], list)
    assert isinstance(data["significant_control"][0], dict)
    assert data["significant_control"][0]["organization"] == "First HoldCo"
    # Must survive a JSON round trip -- it is written to Sheets and static JSON.
    json.dumps(data)


def test_pinned_rules_are_sent_on_every_call(stub_lm):
    """
    GEPA rewrites the instruction, so the injection directive and the
    never-estimate rule are passed as an input value instead. If this field ever
    stops being populated, an optimised program could quietly drop them.
    """
    program = IntelligenceExtractor()
    program(title="t", article_text="b")
    call = dspy.settings.lm.history[-1]
    prompt = json.dumps(call)
    assert "SECURITY" in prompt
    assert "NEVER estimate" in prompt
    assert "publication reporting the story" in prompt


def test_pinned_rules_are_not_part_of_the_evolvable_instruction():
    """
    The instruction is what GEPA mutates. The pinned rules must not live there,
    or an optimiser could delete them in a single proposal.
    """
    instruction = ExtractIntelligence.instructions
    assert "SECURITY" not in instruction
    assert "NEVER estimate" not in instruction
    # They belong to the module, which always supplies them.
    assert "SECURITY" in PINNED_RULES


def test_missing_artifact_falls_back_instead_of_raising():
    program = load_extractor("/nonexistent/extraction_gepa.json")
    assert isinstance(program, IntelligenceExtractor)


def test_unreadable_artifact_falls_back_instead_of_raising(tmp_path):
    bad = tmp_path / "extraction_gepa.json"
    bad.write_text("this is not json")
    program = load_extractor(str(bad))
    assert isinstance(program, IntelligenceExtractor)


def test_signature_declares_the_psc_fields_the_register_needs():
    fields = ExtractIntelligence.output_fields
    assert "significant_control" in fields
    assert "organizations" in fields
    assert "relevant" in fields
