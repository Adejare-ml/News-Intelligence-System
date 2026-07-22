import re
import spacy
from bs4 import BeautifulSoup
from sentence_transformers import SentenceTransformer
from typing import Dict, Any, List, Tuple
import logging

logger = logging.getLogger(__name__)

# Load models
try:
    nlp = spacy.load("en_core_web_sm")
except Exception as e:
    logger.warning(f"Could not load spaCy model en_core_web_sm: {e}. Downloading now...")
    try:
        spacy.cli.download("en_core_web_sm")
        nlp = spacy.load("en_core_web_sm")
    except Exception as download_err:
        logger.error(f"Failed to download spaCy model: {download_err}")
        nlp = None

try:
    embedding_model = SentenceTransformer("all-MiniLM-L6-v2")
except Exception as e:
    logger.error(f"Could not load SentenceTransformer model: {e}")
    embedding_model = None

# Vocab lists for Rule-Based Classification
TITLES_VOCAB = [
    "CEO", "Chief Executive Officer", "Chairman", "Managing Director", "Director",
    "Commissioner", "Minister", "Governor", "President", "Judge", 
    "Permanent Secretary", "Board Member", "Major Investor", "Business Owner",
    "Politician", "Senior Civil Servant", "Military Officer", "Head of Agency"
]

RISK_KEYWORDS = {
    "Critical": ["corruption", "fraud", "embezzlement", "money laundering", "bribery", "indictment", "arrested for fraud", "bankruptcy", "insolvency"],
    "High": ["investigation", "court case", "lawsuit", "conviction", "regulatory action", "sanction", "dismissal", "suspended", "tax dispute", "prosecution"],
    "Medium": ["resignation", "layoffs", "office closure", "dispute", "fine", "compliance issue", "audit report"],
    "Low": ["appointment", "promotion", "merger", "acquisition", "funding round", "ipo", "expansion", "partnership"]
}

SENTIMENT_LEXICON = {
    "positive": [
        "appoint", "promote", "partner", "acquire", "growth", "record profit", 
        "expansion", "launched", "funding", "success", "innovative", "approved",
        "strengthen", "win", "awarded", "achievement", "breakthrough", "gain"
    ],
    "negative": [
        "resign", "retire", "dismiss", "suspend", "fraud", "corruption", "bankruptcy",
        "lawsuit", "sanction", "fine", "dispute", "investigate", "decline", "loss",
        "layoff", "closure", "deficit", "charge", "arrest", "sue", "protest", "fail"
    ]
}

class NLPPipelineService:
    @staticmethod
    def clean_html(raw_html: str) -> str:
        """Strips HTML tags and clean whitespace."""
        if not raw_html:
            return ""
        soup = BeautifulSoup(raw_html, "html.parser")
        # remove script and style elements
        for script in soup(["script", "style"]):
            script.decompose()
        text = soup.get_text()
        # break into lines and remove leading and trailing space on each
        lines = (line.strip() for line in text.splitlines())
        # break multi-headlines into a line each
        chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
        # drop blank lines
        return '\n'.join(chunk for chunk in chunks if chunk)

    @staticmethod
    def detect_language(text: str) -> str:
        """Determines if the text is primarily English (heuristic)."""
        if not text:
            return "unknown"
        # Count common English stopwords (excluding short single letter words to avoid foreign collisions)
        stopwords = {"the", "be", "to", "of", "and", "in", "that", "have", "it", "for", "not", "on", "with", "he", "as", "you", "do", "at"}
        words = re.findall(r'\b[a-z]+\b', text.lower())
        if not words:
            return "unknown"
        english_word_count = sum(1 for w in words if w in stopwords)
        ratio = english_word_count / len(words) if words else 0
        if ratio > 0.10:
            return "en"
        return "other"

    @staticmethod
    def generate_embeddings(text: str) -> List[float]:
        """Generates 384-dimensional vector embeddings using SentenceTransformers."""
        if not embedding_model or not text:
            return []
        # SentenceTransformers returns a numpy array, convert to list
        # Truncate text to standard max length (e.g. 512 tokens / ~1000 characters for embedding performance)
        truncated_text = text[:1500]
        embedding = embedding_model.encode(truncated_text)
        return embedding.tolist()

    @staticmethod
    def extract_named_entities(text: str) -> Dict[str, List[str]]:
        """Extracts Person, Organization, Location entities using spaCy."""
        entities = {
            "people": [],
            "organizations": [],
            "locations": [],
            "positions": []
        }
        if not nlp or not text:
            return entities
        
        doc = nlp(text[:50000]) # Limit length to prevent memory overload
        
        # Standard NER extraction
        for ent in doc.ents:
            cleaned_name = ent.text.strip().replace("\n", " ")
            if len(cleaned_name) < 2:
                continue
            if ent.label_ == "PERSON":
                # Ensure no titles are in the person name (e.g. "CEO John Doe" -> "John Doe")
                name_without_title = cleaned_name
                for title in TITLES_VOCAB:
                    name_without_title = re.sub(rf'\b{title}\b\s*', '', name_without_title, flags=re.IGNORECASE)
                name_without_title = name_without_title.strip()
                if len(name_without_title) > 2 and name_without_title not in entities["people"]:
                    entities["people"].append(name_without_title)
            elif ent.label_ in ["ORG"]:
                if cleaned_name not in entities["organizations"]:
                    entities["organizations"].append(cleaned_name)
            elif ent.label_ in ["GPE", "LOC"]:
                if cleaned_name not in entities["locations"]:
                    entities["locations"].append(cleaned_name)

        # Keyword matching for Positions
        for title in TITLES_VOCAB:
            # Check if title is mentioned in text
            pattern = rf'\b{re.escape(title)}s?\b'
            if re.search(pattern, text, re.IGNORECASE):
                if title not in entities["positions"]:
                    entities["positions"].append(title)

        return entities

    @staticmethod
    def extract_relationships(text: str, entities: Dict[str, List[str]]) -> List[Dict[str, Any]]:
        """Extracts Subject-Predicate-Object relationships using spaCy dependency parsing and heuristics."""
        relationships = []
        if not nlp or not text:
            return relationships

        # Split text into sentences and process
        doc = nlp(text[:10000])
        for sent in doc.sents:
            # Check for verbs indicating relationship
            sent_text = sent.text
            verb_match = None
            predicates = ["appoint", "hire", "resign", "retire", "acquire", "buy", "partner", "investigate", "dismiss", "suspend", "sue"]
            
            # Simple heuristic matching within the sentence
            for pred in predicates:
                if re.search(rf'\b{pred}\w*\b', sent_text, re.IGNORECASE):
                    verb_match = pred
                    break
            
            if not verb_match:
                continue

            # Let's extract subjects and objects present in this sentence from our entities lists
            sentence_people = [p for p in entities["people"] if p in sent_text]
            sentence_orgs = [o for o in entities["organizations"] if o in sent_text]
            sentence_positions = [pos for pos in entities["positions"] if pos in sent_text]

            # Heuristics based on verb
            if verb_match in ["appoint", "hire"]:
                # E.g. "Federal Government appoints Jane Doe as Permanent Secretary"
                # Subject: Org (Federal Government), Predicate: "appointed", Object: Person (Jane Doe) or Position
                subj = sentence_orgs[0] if sentence_orgs else "Government"
                obj = sentence_people[0] if sentence_people else (sentence_positions[0] if sentence_positions else "Unknown Person")
                relationships.append({
                    "subject": subj,
                    "predicate": "appointed",
                    "object": obj,
                    "confidence_score": 0.8
                })
            elif verb_match in ["resign", "retire"]:
                # E.g. "John Doe resigns from XYZ Limited"
                # Subject: Person, Predicate: "resigned from", Object: Org
                subj = sentence_people[0] if sentence_people else "Executive"
                obj = sentence_orgs[0] if sentence_orgs else "Company"
                relationships.append({
                    "subject": subj,
                    "predicate": "resigned from",
                    "object": obj,
                    "confidence_score": 0.85
                })
            elif verb_match in ["acquire", "buy"]:
                # E.g. "ABC Holdings acquired DEF Limited"
                # Subject: Org (ABC Holdings), Predicate: "acquired", Object: Org (DEF Limited)
                if len(sentence_orgs) >= 2:
                    relationships.append({
                        "subject": sentence_orgs[0],
                        "predicate": "acquired",
                        "object": sentence_orgs[1],
                        "confidence_score": 0.9
                    })
            elif verb_match in ["partner"]:
                # E.g. "ABC and DEF partnered"
                if len(sentence_orgs) >= 2:
                    relationships.append({
                        "subject": sentence_orgs[0],
                        "predicate": "partnered with",
                        "object": sentence_orgs[1],
                        "confidence_score": 0.85
                    })
            elif verb_match in ["investigate", "sue"]:
                # E.g. "SEC investigates XYZ Limited"
                subj = sentence_orgs[0] if sentence_orgs else "Regulatory Body"
                obj = sentence_orgs[1] if len(sentence_orgs) >= 2 else (sentence_people[0] if sentence_people else "Company")
                relationships.append({
                    "subject": subj,
                    "predicate": "investigating" if verb_match == "investigate" else "suing",
                    "object": obj,
                    "confidence_score": 0.75
                })

        return relationships

    @staticmethod
    def analyze_sentiment(text: str) -> str:
        """Determines sentiment (Positive, Negative, Neutral) using lexical rules."""
        if not text:
            return "Neutral"
        
        text_lower = text.lower()
        pos_score = sum(text_lower.count(word) for word in SENTIMENT_LEXICON["positive"])
        neg_score = sum(text_lower.count(word) for word in SENTIMENT_LEXICON["negative"])
        
        if pos_score > neg_score + 1:
            return "Positive"
        elif neg_score > pos_score + 1:
            return "Negative"
        return "Neutral"

    @staticmethod
    def classify_risk(text: str) -> str:
        """Classifies risk level (Low, Medium, High, Critical) based on keyword matching."""
        if not text:
            return "Low"
            
        text_lower = text.lower()
        
        # Check Critical keywords
        for keyword in RISK_KEYWORDS["Critical"]:
            if re.search(rf'\b{re.escape(keyword)}s?\b', text_lower):
                return "Critical"
                
        # Check High keywords
        for keyword in RISK_KEYWORDS["High"]:
            if re.search(rf'\b{re.escape(keyword)}s?\b', text_lower):
                return "High"
                
        # Check Medium keywords
        for keyword in RISK_KEYWORDS["Medium"]:
            if re.search(rf'\b{re.escape(keyword)}s?\b', text_lower):
                return "Medium"
                
        return "Low"

    @staticmethod
    def calculate_importance_score(text: str, entities: Dict[str, List[str]], category: str) -> float:
        """Calculates article importance score (0-100) based on multiple factors."""
        if not text:
            return 0.0
            
        score = 30.0 # Base score
        
        # 1. Government levels and seniority factors
        if category == "Government":
            score += 15.0
            # Higher score for federal/state/ministers
            if any(term in text.lower() for term in ["federal", "national", "minister", "president", "governor", "ministry"]):
                score += 15.0
        
        # 2. Executive seniority
        senior_positions = ["CEO", "Chief Executive", "Chairman", "Managing Director", "Permanent Secretary"]
        if any(pos.lower() in [p.lower() for p in entities.get("positions", [])] for pos in senior_positions):
            score += 15.0
            
        # 3. Size and weight of entities
        people_count = len(entities.get("people", []))
        orgs_count = len(entities.get("organizations", []))
        score += min(people_count * 2.0, 10.0)
        score += min(orgs_count * 3.0, 15.0)
        
        # 4. Critical events/breaking indicators
        if any(term in text.lower() for term in ["breaking", "announces", "acquired", "merger", "bankruptcy", "court", "arrest"]):
            score += 10.0
            
        # Limit score between 0 and 100
        return float(max(0.0, min(100.0, score)))

    @staticmethod
    def detect_category(text: str) -> str:
        """Classifies the main category of the news (Government, Company, Person, Legal, General)."""
        if not text:
            return "General"
            
        text_lower = text.lower()
        
        # Keywords
        gov_keywords = ["ministry", "minister", "agency", "department", "parliament", "psc", "civil service", "commissioner", "governor", "senate", "federal government", "public service commission"]
        company_keywords = ["corp", "inc", "limited", "ltd", "shares", "stock", "merger", "acquisition", "board changes", "ipo", "delisting", "revenue", "fiscal", "quarter", "earnings"]
        legal_keywords = ["court", "judge", "sue", "lawsuit", "prosecution", "investigation", "sanctions", "compliance", "arrest", "indictment", "trial", "conviction"]
        
        gov_count = sum(text_lower.count(word) for word in gov_keywords)
        company_count = sum(text_lower.count(word) for word in company_keywords)
        legal_count = sum(text_lower.count(word) for word in legal_keywords)
        
        if gov_count > company_count and gov_count > legal_count:
            return "Government"
        elif company_count > gov_count and company_count > legal_count:
            return "Company"
        elif legal_count > gov_count and legal_count > company_count:
            return "Legal"
        
        # Check if contains Person and a title
        person_titles = ["ceo", "chairman", "director", "secretary", "minister"]
        if any(t in text_lower for t in person_titles):
            return "Person"
            
        return "General"

    @classmethod
    def generate_summaries(cls, title: str, text: str) -> Dict[str, str]:
        """Generates multi-level extractive summaries (One-line, Executive, Detailed, Timeline)."""
        summaries = {
            "one_line": title,
            "executive": "",
            "detailed": "",
            "timeline": ""
        }
        
        if not text:
            return summaries

        # Split into sentences using a simple regex (since spaCy might not be loaded)
        sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', text) if s.strip()]
        
        if not sentences:
            return summaries
            
        # One-line: title or first sentence
        summaries["one_line"] = sentences[0][:200] if len(sentences) > 0 else title
        
        # Executive summary: First 2 sentences
        summaries["executive"] = " ".join(sentences[:2])
        
        # Detailed summary: First 4 sentences
        summaries["detailed"] = " ".join(sentences[:5])
        
        # Timeline summary: Extract sentences containing dates or time expressions
        date_sentences = []
        date_patterns = [r'\b(19|20)\d{2}\b', r'\b(January|February|March|April|May|June|July|August|September|October|November|December)\b', r'\b(today|yesterday|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b']
        for s in sentences:
            if any(re.search(pat, s, re.IGNORECASE) for pat in date_patterns):
                date_sentences.append(s)
                if len(date_sentences) >= 3:
                    break
        
        # Fallback to first 3 sentences if no date sentences found
        if not date_sentences:
            date_sentences = sentences[:3]
            
        summaries["timeline"] = " \n- ".join([""] + date_sentences)
        
        return summaries
