import sys
import os

# Add repo root to pythonpath
sys.path.insert(0, os.path.abspath("."))

from backend.app.services.nlp_pipeline import NLPPipelineService

def test_nlp_pipeline():
    print("Testing NLPPipelineService with HF zero-shot & fallback...")
    
    sample_text = "The Federal Ministry of Finance announced an investigation into corporate tax fraud and money laundering allegations."
    
    risk = NLPPipelineService.classify_risk(sample_text)
    category = NLPPipelineService.detect_category(sample_text)
    sentiment = NLPPipelineService.analyze_sentiment(sample_text)
    
    print(f"Sample Text: {sample_text}")
    print(f"Detected Risk: {risk}")
    print(f"Detected Category: {category}")
    print(f"Detected Sentiment: {sentiment}")
    
    assert risk in ["Critical", "High", "Medium", "Low"]
    assert category in ["Government", "Company", "Person", "Legal", "General"]
    print("NLP PIPELINE TEST PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    test_nlp_pipeline()
