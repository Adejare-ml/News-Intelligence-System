import pytest
from backend.app.services.ingestion import NewsIngestionService
from backend.app.services.llm import LLMService
from run_pipeline import make_node_id

def test_fuzzy_deduplication():
    raw_articles = [
        {"title": "Tinubu Appoints Jane Doe as Permanent Secretary of Agriculture", "url": "https://a.com/1"},
        {"title": "FG Appoints Jane Doe as Permanent Secretary of Agriculture", "url": "https://b.com/2"},
        {"title": "SEC Launches Formal Audit into Apex Energy Corp", "url": "https://c.com/3"}
    ]
    deduped = NewsIngestionService.fuzzy_deduplicate_articles(raw_articles)
    assert len(deduped) == 2
    assert deduped[0]["title"] == "Tinubu Appoints Jane Doe as Permanent Secretary of Agriculture"
    assert deduped[1]["title"] == "SEC Launches Formal Audit into Apex Energy Corp"

def test_extract_json_block():
    markdown_json = """
    Here is the analysis:
    ```json
    {
        "relevant": true,
        "category": "Company",
        "risk_score": 75
    }
    ```
    End of response.
    """
    extracted = LLMService._extract_json_block(markdown_json)
    assert extracted is not None
    assert extracted["relevant"] is True
    assert extracted["category"] == "Company"
    assert extracted["risk_score"] == 75

def test_deterministic_node_id():
    id1 = make_node_id("Apex Technology Group")
    id2 = make_node_id("apex technology group")
    id3 = make_node_id("  APEX TECHNOLOGY GROUP  ")
    assert id1 == id2 == id3
    assert len(id1) == 12
