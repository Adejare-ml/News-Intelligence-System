import pytest
from backend.app.services.llm import build_report_prompt


def test_report_prompt_requests_psc_section():
    prompt = build_report_prompt("[]")
    assert "Beneficial Ownership & PSC Disclosures" in prompt


def test_report_prompt_keeps_existing_sections():
    prompt = build_report_prompt("[]")
    for section in ["Key Developments", "High Risk Alerts", "Procurement & Board Changes"]:
        assert section in prompt, f"Existing report section lost: {section}"


def test_report_prompt_embeds_the_data():
    prompt = build_report_prompt('{"marker": "xyzzy"}')
    assert "xyzzy" in prompt


def test_report_prompt_asks_for_ownership_specifics():
    """The PSC section is only useful if it names holders, stakes and vehicles."""
    prompt = build_report_prompt("[]").lower()
    for term in ["pep", "indirect", "percentage"]:
        assert term in prompt, f"PSC prompt missing guidance on: {term}"
