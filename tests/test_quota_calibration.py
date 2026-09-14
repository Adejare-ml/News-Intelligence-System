"""LLM quota + extraction calibration (Package 16).

The prompt-side assertions pin the CAMA 2020 recalibration: the model
was being taught the UK's 25% PSC threshold while the product's whole
premise is Nigeria's 5% one -- the 5-25% band could only ever be
populated by demo seed rows.
"""

from backend.app.db.excel_db import SheetsDatabase, _risk_rank
from backend.app.services import relevance
from backend.app.services.dspy_extract import Organization, SignificantControl
from backend.app.services.llm import SYSTEM_PROMPT


class TestPromptCalibration:
    def test_prompt_states_the_nigerian_5_percent_threshold(self):
        assert "5%" in SYSTEM_PROMPT
        assert "CAMA 2020" in SYSTEM_PROMPT
        assert "own >25% of shares" not in SYSTEM_PROMPT, \
            "the UK-threshold definition must not survive"

    def test_nature_of_control_offers_the_nigerian_band(self):
        assert "5-25%" in SYSTEM_PROMPT

    def test_voting_rights_and_industry_are_in_the_schema(self):
        assert "voting_rights_percentage" in SYSTEM_PROMPT
        assert '"industry"' in SYSTEM_PROMPT

    def test_dspy_models_mirror_the_prompt(self):
        assert "voting_rights_percentage" in SignificantControl.model_fields
        assert "industry" in Organization.model_fields
        assert "5%" in (SignificantControl.__doc__ or "")


class TestPreLLMGuardInputs:
    """The guard that now runs before any extraction call must reject the
    junk classes measured in the live corpus -- on the title alone."""

    def test_sport_and_entertainment_titles_reject_title_only(self):
        for title in (
            "Super Eagles beat Ghana 2-0 in World Cup qualifier",
            "BBNaija star announces wedding to fellow housemate",
        ):
            assert relevance.off_topic_reason(title) is not None, title

    def test_corporate_titles_pass_title_only(self):
        for title in (
            "Dangote Cement announces new majority shareholder",
            "CBN sanctions Zenith Bank over disclosure failures",
        ):
            assert relevance.off_topic_reason(title) is None, title


class TestRiskAggregation:
    def test_rank_ordering(self):
        assert _risk_rank("Critical") > _risk_rank("High") > _risk_rank("Medium") \
            > _risk_rank("Low") > _risk_rank("") == _risk_rank(None)
        assert _risk_rank("elevated") == _risk_rank("Medium")

    def test_company_risk_never_downgrades(self, tmp_path):
        db = SheetsDatabase()
        db.use_local = True
        db.local_path = str(tmp_path / "risk.xlsx")
        db._cache = {}
        db._init_db()

        db.add_company({"Company": "Acme Plc", "Industry": "Banking", "Risk Level": "Critical"})
        db.add_company({"Company": "Acme Plc", "Industry": "Banking", "Risk Level": "Low"})
        rows = [r for r in db.get_companies() if r["Company"] == "Acme Plc"]
        assert rows[0]["Risk Level"] == "Critical", \
            "a routine follow-up story must not erase a Critical rating"

        db.add_company({"Company": "Beta Ltd", "Industry": "General", "Risk Level": "Low"})
        db.add_company({"Company": "Beta Ltd", "Industry": "General", "Risk Level": "High"})
        rows = [r for r in db.get_companies() if r["Company"] == "Beta Ltd"]
        assert rows[0]["Risk Level"] == "High", "escalation must still apply"

    def test_industry_never_regresses_to_general(self, tmp_path):
        db = SheetsDatabase()
        db.use_local = True
        db.local_path = str(tmp_path / "industry.xlsx")
        db._cache = {}
        db._init_db()

        db.add_company({"Company": "Acme Plc", "Industry": "General", "Risk Level": "Low"})
        db.add_company({"Company": "Acme Plc", "Industry": "Cement", "Risk Level": "Low"})
        db.add_company({"Company": "Acme Plc", "Industry": "General", "Risk Level": "Low"})
        rows = [r for r in db.get_companies() if r["Company"] == "Acme Plc"]
        assert rows[0]["Industry"] == "Cement"
