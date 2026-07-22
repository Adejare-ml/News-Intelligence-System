import pytest
from backend.app.services.nlp_pipeline import NLPPipelineService

def test_clean_html():
    raw_html = "<html><body><h1>Breaking News</h1><p>Federal Government appoints Jane Doe.</p></body></html>"
    cleaned = NLPPipelineService.clean_html(raw_html)
    assert "Breaking News" in cleaned
    assert "Federal Government" in cleaned
    assert "<html>" not in cleaned

def test_detect_language():
    english_text = "The Federal Government announced new appointments today in the civil service."
    french_text = "Le gouvernement fédéral a annoncé aujourd'hui de nouvelles nominations."
    
    assert NLPPipelineService.detect_language(english_text) == "en"
    assert NLPPipelineService.detect_language(french_text) == "other"

def test_sentiment_analysis():
    positive_text = "Summit Holdings announced a record profit and successful expansion."
    negative_text = "Apex Technology Group is facing bankruptcy and fraud investigations."
    neutral_text = "The committee held a routine meeting on Wednesday morning."

    assert NLPPipelineService.analyze_sentiment(positive_text) == "Positive"
    assert NLPPipelineService.analyze_sentiment(negative_text) == "Negative"
    assert NLPPipelineService.analyze_sentiment(neutral_text) == "Neutral"

def test_classify_risk():
    critical_text = "An executive was arrested today for corruption and embezzlement."
    high_text = "The SEC has launched an investigation and a lawsuit against Vertex Financials."
    low_text = "Vertex Financials announced the appointment of a new director."

    assert NLPPipelineService.classify_risk(critical_text) == "Critical"
    assert NLPPipelineService.classify_risk(high_text) == "High"
    assert NLPPipelineService.classify_risk(low_text) == "Low"

def test_generate_summaries():
    text = "Federal Government appoints Jane Doe as Permanent Secretary. The appointment takes immediate effect. She succeeds the outgoing secretary who retired last month. Stakeholders are optimistic."
    title = "New Permanent Secretary Appointed"
    
    summaries = NLPPipelineService.generate_summaries(title, text)
    assert summaries["one_line"] != ""
    assert "Jane Doe" in summaries["executive"]
    assert "retired last month" in summaries["detailed"]
