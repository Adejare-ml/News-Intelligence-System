import feedparser
import requests
import random
import re
from datetime import datetime, timedelta
from typing import List, Dict, Any
from backend.app.core.config import settings
import logging

logger = logging.getLogger(__name__)

# Mock Data Templates to seed a highly interactive, rich knowledge database
MOCK_COMPANIES = [
    "Apex Technology Group", "Vertex Financials", "Nova Energy Corp", 
    "AeroSpace International", "BioSphere Healthcare", "Summit Holdings"
]
MOCK_AGENCIES = [
    "Public Service Commission", "Federal Trade Commission", 
    "Department of Justice", "Securities and Exchange Commission",
    "Environmental Protection Agency"
]
MOCK_PEOPLE = [
    "Sarah Jenkins", "Robert Chen", "Alice Vance", 
    "Michael Nduka", "Jane Doe", "John Doe", "Dr. Helena Vance"
]
MOCK_POSITIONS = [
    "CEO", "Managing Director", "Permanent Secretary", 
    "Chief Executive Officer", "Chairman", "Director"
]

MOCK_NEWS_TEMPLATES = [
    {
        "headline": "Federal Government appoints {person} as Permanent Secretary of {agency}",
        "category": "Government",
        "event_type": "Appointment",
        "risk_level": "Low",
        "sentiment": "Neutral",
        "template_text": "The Federal Government of Nigeria today announced the appointment of {person} as the new Permanent Secretary of the {agency}. The appointment, which takes immediate effect, was confirmed in a statement signed by the Chairman of the Public Service Commission. {person} succeeds the outgoing secretary who retired last month. Stakeholders have expressed optimism that {person}'s wealth of experience will drive efficiency in the {agency}."
    },
    {
        "headline": "{company} board names {person} as new Chief Executive Officer",
        "category": "Company",
        "event_type": "Appointment",
        "risk_level": "Low",
        "sentiment": "Positive",
        "template_text": "The board of directors of {company} has officially announced the appointment of {person} as the company's new Chief Executive Officer (CEO). {person}, who previously served as Managing Director at a rival firm, will assume the role on the first of next month. The board expressed absolute confidence in {person}'s capability to steer the company through its next phase of global expansion and technological transformation."
    },
    {
        "headline": "SEC Launches Investigation into {company} over Compliance Issues",
        "category": "Legal",
        "event_type": "Investigation",
        "risk_level": "High",
        "sentiment": "Negative",
        "template_text": "The Securities and Exchange Commission (SEC) has initiated a formal investigation into the financial reporting standards of {company}. According to sources close to the regulatory body, the inquiry centers on potential compliance issues and accounting discrepancies flagged during an external audit. Shares of {company} fell by 4.5% following the announcement, as investors await a formal statement from the board."
    },
    {
        "headline": "{company} Announces Successful Acquisition of {company_target} for $2.4B",
        "category": "Company",
        "event_type": "Company acquisition",
        "risk_level": "Low",
        "sentiment": "Positive",
        "template_text": "In a major consolidation of the sector, {company} has entered into a definitive agreement to acquire {company_target} in an all-cash transaction valued at approximately $2.4 billion. The acquisition has been approved by the boards of both companies and is subject to standard regulatory approvals. The merger is expected to create significant synergies, combining {company}'s market reach with {company_target}'s proprietary technology suite."
    },
    {
        "headline": "{person} Resigns from {company} Board Following Regulatory Sanctions",
        "category": "Company",
        "event_type": "Resignation",
        "risk_level": "Medium",
        "sentiment": "Negative",
        "template_text": "High-profile board member {person} has tendered their resignation from {company}, effective immediately. This development follows recent regulatory sanctions imposed on the firm for environmental compliance failures. In a brief statement, {person} indicated that the decision was made to allow the board to restructure and address regulatory concerns with a fresh perspective. The company's chairman thanked {person} for their service."
    },
    {
        "headline": "{agency} Imposes Heavy Fines on {company} over Anti-Trust Violations",
        "category": "Legal",
        "event_type": "Sanctions",
        "risk_level": "High",
        "sentiment": "Negative",
        "template_text": "The {agency} has concluded its anti-trust probe into {company}, imposing a record-breaking regulatory fine. The investigation, which spanned over eighteen months, found that {company} engaged in anti-competitive practices that locked competitors out of key markets. In addition to the fine, the {agency} has ordered {company} to modify its licensing agreements and submit to annual compliance audits."
    }
]

def parse_feed_date(date_str: str) -> datetime:
    """Helper to parse feed publication date string into a datetime object."""
    if not date_str:
        return datetime.now()
    
    date_clean = date_str.replace("Z", "").strip()
    
    formats = [
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M:%S.%f",
        "%a, %d %b %Y %H:%M:%S %Z",
        "%a, %d %b %Y %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S.%f"
    ]
    
    if "." in date_clean:
        date_clean = date_clean.split(".")[0]
        
    for fmt in formats:
        try:
            return datetime.strptime(date_clean, fmt)
        except ValueError:
            continue
            
    try:
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(date_str).replace(tzinfo=None)
    except Exception:
        pass
        
    return datetime.now()

class NewsIngestionService:
    @staticmethod
    def fetch_google_news_rss(query: str = None) -> List[Dict[str, Any]]:
        """Fetches and parses articles from Google News RSS feed, targeting Nigerian PSCs, companies, and agencies."""
        logger.info("Fetching articles from Google News RSS...")
        
        # Site operators provided in prompt
        site_filter = "site:gov.ng OR site:com.ng OR site:premiumtimesng.com OR site:punchng.com OR site:guardian.ng OR site:vanguardngr.com OR site:thecable.ng OR site:leadership.ng OR site:thisdaylive.com OR site:businessday.ng"
        
        queries = []
        if query:
            queries = [f"{query} ({site_filter})"]
        else:
            # Structuring queries matching Categories 1-9 to fetch in batches
            queries = [
                f'("Public Sector Company" OR "PSC Nigeria" OR Parastatal OR "Government Agency" OR CEO OR Board) ({site_filter})',
                f'(Tender OR Procurement OR "Contract Award" OR "Bid Opening" OR regulation OR compliance) ({site_filter})',
                f'(Budget OR Revenue OR Audit OR Fraud OR "EFCC investigation" OR "ICPC investigation" OR bribery) ({site_filter})',
                f'(NNPC OR NIMASA OR NPA OR FAAN OR NITDA OR CBN OR FIRS OR NERC OR BPE OR NDDC) ({site_filter})'
            ]
            
        articles = []
        urls_processed = set()
        
        for q in queries:
            url = f"https://news.google.com/rss/search?q={requests.utils.quote(q)}&hl=en-NG&gl=NG&ceid=NG:en"
            try:
                feed = feedparser.parse(url)
                for entry in feed.entries:
                    if entry.link in urls_processed:
                        continue
                    urls_processed.add(entry.link)
                    
                    articles.append({
                        "title": entry.title,
                        "url": entry.link,
                        "source": entry.source.title if hasattr(entry, 'source') else "Google News",
                        "published_at": entry.published if hasattr(entry, 'published') else datetime.now().isoformat(),
                        "raw_text": entry.summary if hasattr(entry, 'summary') else entry.title,
                        "is_rss": True
                    })
            except Exception as e:
                logger.error(f"Error fetching Google News RSS query '{q}': {e}")
                
        logger.info(f"Successfully fetched {len(articles)} combined RSS entries.")
        return articles

    @staticmethod
    def _fetch_from_news_api_with_key(key: str) -> List[Dict[str, Any]]:
        """Helper to call NewsAPI search for Nigerian business headlines."""
        # Querying business topics in Nigeria, matching our target categories
        url = f"https://newsapi.org/v2/everything?q={requests.utils.quote('Nigeria (PSC OR NNPC OR CEO OR contract OR EFCC OR NIMASA OR parastatal)')}&sortBy=publishedAt&apiKey={key}"
        r = requests.get(url, timeout=10)
        if r.status_code == 200:
            data = r.json()
            articles = []
            for item in data.get("articles", []):
                articles.append({
                    "title": item.get("title"),
                    "url": item.get("url"),
                    "source": item.get("source", {}).get("name", "NewsAPI"),
                    "published_at": item.get("publishedAt"),
                    "raw_text": item.get("content") or item.get("description") or "",
                    "is_rss": False
                })
            return articles
        else:
            raise requests.HTTPError(f"HTTP {r.status_code}: {r.text}")

    @classmethod
    def fetch_news_api(cls) -> List[Dict[str, Any]]:
        """Fetches articles using NewsAPI with fallback retry logic."""
        if not settings.NEWSAPI_KEY:
            return []
            
        logger.info("Attempting NewsAPI fetch with Key 1...")
        try:
            return cls._fetch_from_news_api_with_key(settings.NEWSAPI_KEY)
        except Exception as e:
            logger.warning(f"NewsAPI Key 1 failed or rate-limited: {e}. Retrying with Key 2...")
            if settings.NEWSAPI_KEY_2:
                try:
                    return cls._fetch_from_news_api_with_key(settings.NEWSAPI_KEY_2)
                except Exception as e2:
                    logger.error(f"NewsAPI Key 2 also failed: {e2}")
            else:
                logger.warning("No NewsAPI Key 2 (fallback) configured.")
        return []

    @staticmethod
    def fetch_gnews() -> List[Dict[str, Any]]:
        """Fetches articles using GNews API if key is available."""
        if not settings.GNEWS_KEY:
            return []
            
        logger.info("Fetching from GNews...")
        url = f"https://gnews.io/api/v4/top-headlines?category=business&lang=en&country=ng&apikey={settings.GNEWS_KEY}"
        try:
            r = requests.get(url, timeout=10)
            if r.status_code == 200:
                data = r.json()
                articles = []
                for item in data.get("articles", []):
                    articles.append({
                        "title": item.get("title"),
                        "url": item.get("url"),
                        "source": item.get("source", {}).get("name", "GNews"),
                        "published_at": item.get("publishedAt"),
                        "raw_text": item.get("content") or item.get("description") or "",
                        "is_rss": False
                    })
                return articles
        except Exception as e:
            logger.error(f"Error fetching GNews: {e}")
        return []

    @staticmethod
    def fetch_guardian_news() -> List[Dict[str, Any]]:
        """Fetches articles from The Guardian Open Platform using the configured API key."""
        if not settings.GUARDIAN_API_KEY:
            return []

        logger.info("Fetching from The Guardian Open Platform...")
        url = f"https://content.guardianapis.com/search?q=Nigeria&api-key={settings.GUARDIAN_API_KEY}&show-fields=bodyText&page-size=25"
        try:
            r = requests.get(url, timeout=10)
            if r.status_code == 200:
                data = r.json()
                results = data.get("response", {}).get("results", [])
                articles = []
                for item in results:
                    fields = item.get("fields", {})
                    articles.append({
                        "title": item.get("webTitle"),
                        "url": item.get("webUrl"),
                        "source": "The Guardian",
                        "published_at": item.get("webPublicationDate"),
                        "raw_text": fields.get("bodyText") or item.get("webTitle"),
                        "is_rss": False
                    })
                logger.info(f"Successfully fetched {len(articles)} articles from The Guardian.")
                return articles
        except Exception as e:
            logger.error(f"Error fetching from The Guardian: {e}")
        return []

    @staticmethod
    def fetch_newsdata_io() -> List[Dict[str, Any]]:
        """Fetches articles from NewsData.io API (specifically Nigerian news for target seed agency monitoring)."""
        if not settings.NEWSDATA_KEY:
            return []

        logger.info("Fetching from NewsData.io...")
        url = f"https://newsdata.io/api/1/latest?country=ng&apikey={settings.NEWSDATA_KEY}"
        try:
            r = requests.get(url, timeout=10)
            if r.status_code == 200:
                data = r.json()
                results = data.get("results", [])
                articles = []
                for item in results:
                    articles.append({
                        "title": item.get("title"),
                        "url": item.get("link"),
                        "source": item.get("source_id") or "NewsData",
                        "published_at": item.get("pubDate"),
                        # Fallback content to description, then title
                        "raw_text": item.get("content") or item.get("description") or item.get("title"),
                        "is_rss": False
                    })
                logger.info(f"Successfully fetched {len(articles)} articles from NewsData.io.")
                return articles
        except Exception as e:
            logger.error(f"Error fetching from NewsData.io: {e}")
        return []

    @classmethod
    def generate_mock_news(cls, count: int = 15) -> List[Dict[str, Any]]:
        """Generates realistic mock corporate and government intelligence news to seed the system."""
        logger.info(f"Generating {count} high-fidelity mock news articles...")
        articles = []
        
        # Fixed dates spread out over the last 10 days to make timeline interesting
        base_date = datetime.now()
        
        for i in range(count):
            template = random.choice(MOCK_NEWS_TEMPLATES)
            
            # Draw random entities
            p = random.choice(MOCK_PEOPLE)
            c = random.choice(MOCK_COMPANIES)
            c_target = random.choice([x for x in MOCK_COMPANIES if x != c])
            a = random.choice(MOCK_AGENCIES)
            
            # Format text
            headline = template["headline"].format(person=p, company=c, company_target=c_target, agency=a)
            text = template["template_text"].format(person=p, company=c, company_target=c_target, agency=a)
            
            # Random date
            pub_date = base_date - timedelta(days=random.randint(0, 10), hours=random.randint(0, 23))
            
            # Sources
            src = random.choice(["Reuters Intelligence", "Bloomberg Business", "Financial Times News", "Wall Street Journal"])
            
            # Create a unique-looking URL
            slug = headline.lower().replace(" ", "-").replace("$", "").replace(".", "")
            slug = re.sub(r'[^a-z0-9\-]', '', slug)
            url = f"https://www.{src.lower().replace(' ', '')}.com/articles/{pub_date.strftime('%Y/%m/%d')}/{slug}"
            
            articles.append({
                "title": headline,
                "url": url,
                "source": src,
                "published_at": pub_date.isoformat(),
                "raw_text": text,
                "is_rss": False,
                "mock_category": template["category"],
                "mock_event_type": template["event_type"]
            })
            
        return articles

    @classmethod
    def collect_all(cls) -> List[Dict[str, Any]]:
        """Collects news from all enabled adapters, strictly limited to Nigeria."""
        all_articles = []
        
        # 1. Fetch free Google News RSS (always active)
        rss_articles = cls.fetch_google_news_rss()
        all_articles.extend(rss_articles)
        
        # 2. Try API key adapters
        all_articles.extend(cls.fetch_news_api())
        all_articles.extend(cls.fetch_gnews())
        all_articles.extend(cls.fetch_guardian_news())
        all_articles.extend(cls.fetch_newsdata_io())
        
        # 3. If we don't have enough articles or for demo seed support, add mock news
        if len(all_articles) < 10:
            mock_articles = cls.generate_mock_news(25)
            all_articles.extend(mock_articles)
            
        # Post-ingestion strict Nigeria filter
        nigerian_filtered = []
        for art in all_articles:
            title_lower = (art.get("title") or "").lower()
            text_lower = (art.get("raw_text") or "").lower()
            url_lower = (art.get("url") or "").lower()
            
            is_nigerian = (
                ".ng" in url_lower or 
                "punchng" in url_lower or 
                "vanguardngr" in url_lower or 
                "thecable" in url_lower or 
                "premiumtimesng" in url_lower or 
                "nigeria" in title_lower or 
                "nigeria" in text_lower or
                "nigerian" in title_lower or
                "nigerian" in text_lower or
                "abuja" in title_lower or
                "abuja" in text_lower or
                "lagos" in title_lower or
                "lagos" in text_lower or
                "nnpc" in title_lower or "nnpc" in text_lower or
                "efcc" in title_lower or "efcc" in text_lower or
                "cbn" in title_lower or "cbn" in text_lower or
                "firs" in title_lower or "firs" in text_lower or
                "nimasa" in title_lower or "nimasa" in text_lower or
                "fgn" in title_lower or "fgn" in text_lower
            )
            if is_nigerian:
                nigerian_filtered.append(art)
                
        # 4. Limit to last 48 hours
        limit_date = datetime.now() - timedelta(hours=48)
        time_filtered = []
        for art in nigerian_filtered:
            pub_date = parse_feed_date(art.get("published_at"))
            if pub_date >= limit_date:
                time_filtered.append(art)
                
        # 5. Fuzzy Title Deduplication
        distinct_articles = cls.fuzzy_deduplicate_articles(time_filtered)
        
        logger.info(f"Filtered {len(all_articles)} raw entries to {len(nigerian_filtered)} strictly Nigerian, {len(time_filtered)} within 48h, and {len(distinct_articles)} distinct stories.")
        return distinct_articles

    @staticmethod
    def fuzzy_deduplicate_articles(articles: List[Dict[str, Any]], similarity_threshold: float = 0.70) -> List[Dict[str, Any]]:
        """Deduplicates articles based on title similarity ratio using difflib and token set overlap."""
        from difflib import SequenceMatcher
        deduped = []
        
        for art in articles:
            title = (art.get("title") or "").strip().lower()
            if not title:
                continue
                
            is_dup = False
            title_words = set(re.findall(r'\w+', title))
            
            for existing in deduped:
                ex_title = (existing.get("title") or "").strip().lower()
                ex_words = set(re.findall(r'\w+', ex_title))
                
                # Check 1: SequenceMatcher ratio
                ratio = SequenceMatcher(None, title, ex_title).ratio()
                
                # Check 2: Jaccard word set overlap
                overlap = 0.0
                if title_words and ex_words:
                    overlap = len(title_words & ex_words) / len(title_words | ex_words)
                    
                if ratio >= similarity_threshold or overlap >= 0.65:
                    is_dup = True
                    break
                    
            if not is_dup:
                deduped.append(art)
                
        logger.info(f"Fuzzy Deduplication: Reduced {len(articles)} candidate items to {len(deduped)} distinct stories.")
        return deduped

