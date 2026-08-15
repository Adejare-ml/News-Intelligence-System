import feedparser
import requests
import random
import re
import html
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from backend.app.core.config import settings
import logging

logger = logging.getLogger(__name__)

# Mock Data Templates to seed a highly interactive, rich knowledge database
# The byline on every generated article. Deliberately not a real masthead, and
# deliberately self-describing, because it is what the Source column shows in
# the dashboard, the article modal and the CSV export.
SYNTHETIC_SOURCE = "AURA SAMPLE (synthetic, not real reporting)"

MOCK_COMPANIES = [
    "Apex Technology Group", "Vertex Financials", "Nova Energy Corp", 
    "AeroSpace International", "BioSphere Healthcare", "Summit Holdings"
]
# Fictional, deliberately -- the masthead fix above is pointless if a
# generated story instead asserts a fabricated investigation or sanction
# against a real regulator. None of these are real bodies.
MOCK_AGENCIES = [
    "Bureau of Civil Appointments", "National Standards and Trade Bureau",
    "Office of Public Integrity", "National Markets Oversight Authority",
    "National Environmental Compliance Bureau"
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
        "template_text": "The Federal Government of Nigeria today announced the appointment of {person} as the new Permanent Secretary of the {agency}. The appointment, which takes immediate effect, was confirmed in a statement signed by the Chairman of the Bureau of Civil Appointments. {person} succeeds the outgoing secretary who retired last month. Stakeholders have expressed optimism that {person}'s wealth of experience will drive efficiency in the {agency}."
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
        "headline": "NMOA Launches Investigation into {company} over Compliance Issues",
        "category": "Legal",
        "event_type": "Investigation",
        "risk_level": "High",
        "sentiment": "Negative",
        "template_text": "The National Markets Oversight Authority (NMOA) has initiated a formal investigation into the financial reporting standards of {company}. According to sources close to the regulatory body, the inquiry centers on potential compliance issues and accounting discrepancies flagged during an external audit. Shares of {company} fell by 4.5% following the announcement, as investors await a formal statement from the board."
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

def parse_feed_date(date_str: str) -> Optional[datetime]:
    """
    Parse a feed publication date, or return None when it cannot be established.

    This used to fall back to datetime.now() on every failure, which made an
    article of unknown age indistinguishable from one published this minute.
    The consequence was not cosmetic: the only caller is the 48-hour freshness
    gate, and now() is always inside a window ending at now(), so every article
    with a missing or unrecognised date passed the filter unconditionally and
    then sorted to the top of a feed ordered newest-first. An undated story was
    presented as breaking news.

    None means "not known". Callers decide what to do about that; they must not
    be handed a fabricated timestamp that reads as fact.
    """
    if not date_str:
        return None

    date_clean = str(date_str).replace("Z", "").strip()
    if not date_clean:
        return None
    
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

    return None

# Whole-title matches only. Substring matching would be wrong here: "register"
# alone is chrome, but "PSC register" and "beneficial ownership register" are
# exactly what this pipeline exists to find.
_NAV_STUB_TITLES = {
    "home", "homepage", "account login", "login", "log in", "sign in", "sign up",
    "contact us", "contact", "about us", "about", "privacy policy", "terms",
    "terms of use", "terms and conditions", "faq", "faqs", "help", "support",
    "search", "search results", "portal", "dashboard", "downloads", "download",
    "register", "registration", "services", "our services", "news", "latest news",
    "media centre", "media center", "press releases", "gallery", "sitemap",
}


def _normalise_title(value: Any) -> str:
    return " ".join(str(value or "").replace("\xa0", " ").split()).strip().lower()


def is_navigation_stub(title: Any, source: Any = None) -> bool:
    """True when a feed entry is site chrome rather than a story.

    Two signals, both conservative:

    * The title is nothing but the publication's own name. Google News renders
      a homepage as "Corporate Affairs Commission - Corporate Affairs Commission".
    * The whole title is a navigation label.
    """
    clean = _normalise_title(title)
    if not clean:
        return True

    if clean in _NAV_STUB_TITLES:
        return True

    src = _normalise_title(source)
    if src:
        # "Corporate Affairs Commission - Corporate Affairs Commission"
        stripped = clean
        for sep in (" - ", " | ", " – ", " — "):
            if stripped.endswith(sep + src):
                stripped = stripped[: -(len(sep) + len(src))].strip()
                break
        if stripped == src or clean == src:
            return True
        if stripped in _NAV_STUB_TITLES:
            return True
        # "NAICOM Home - NAICOM" -> strip the trailing source, then the leading
        # one, leaving the bare navigation label.
        if stripped.startswith(src + " ") and stripped[len(src) + 1:] in _NAV_STUB_TITLES:
            return True

    return False


class NewsIngestionService:
    # Publications the pipeline trusts for Nigerian corporate reporting.
    SITE_FILTER = (
        "site:gov.ng OR site:com.ng OR site:premiumtimesng.com OR site:punchng.com "
        "OR site:guardian.ng OR site:vanguardngr.com OR site:thecable.ng "
        "OR site:leadership.ng OR site:thisdaylive.com OR site:businessday.ng "
        "OR site:nairametrics.com OR site:proshare.co"
    )

    # Search topics, ordered by how central they are to the product.
    #
    # The first query used to read:
    #     ("Public Sector Company" OR "PSC Nigeria" OR Parastatal OR ... )
    # which searched for *public sector companies*. In this product PSC means
    # **Persons with Significant Control** — beneficial owners under CAMA 2020.
    # The pipeline was therefore trawling for parastatal news and, unsurprisingly,
    # never surfaced a single ownership disclosure: every daily brief reported
    # "no PSC or beneficial ownership disclosures present in the dataset".
    #
    # Beneficial ownership and corporate governance now lead, and the public
    # sector queries are retained further down as the secondary interest they
    # were always meant to be.
    SEARCH_TOPICS = {
        "beneficial_ownership": (
            '"persons with significant control" OR "person with significant control" '
            'OR "beneficial owner" OR "beneficial ownership" OR "ultimate beneficial owner" '
            'OR "significant control" OR "beneficial interest"'
        ),
        "corporate_registry": (
            '"Corporate Affairs Commission" OR "CAC Nigeria" OR CAMA '
            'OR "companies register" OR "annual return" OR "PSC register" '
            'OR "beneficial ownership register" OR "company filing"'
        ),
        "shareholding_change": (
            '"majority stake" OR "controlling interest" OR "acquires stake" '
            'OR "substantial shareholding" OR "share acquisition" OR "equity stake" '
            'OR shareholding OR divestment OR "share transfer"'
        ),
        "corporate_governance": (
            '"corporate governance" OR "board of directors" OR "annual general meeting" '
            'OR "board appointment" OR "director resigns" OR "chairman appointed" '
            'OR "company secretary" OR "code of corporate governance" OR "board reshuffle"'
        ),
        "market_regulators": (
            '"Securities and Exchange Commission" OR "Nigerian Exchange" OR NGX '
            'OR "Financial Reporting Council" OR CBN OR NAICOM OR PENCOM '
            'OR "regulatory filing" OR "listing rules"'
        ),
        "mergers_acquisitions": (
            'merger OR acquisition OR takeover OR "scheme of arrangement" '
            'OR "business combination" OR "corporate restructuring" OR delisting'
        ),
        "procurement": (
            'Tender OR Procurement OR "Contract Award" OR "Bid Opening" '
            'OR "due diligence" OR compliance'
        ),
        "investigations": (
            'Audit OR Fraud OR "EFCC investigation" OR "ICPC investigation" '
            'OR bribery OR "asset forfeiture" OR "money laundering"'
        ),
        "public_sector": (
            'NNPC OR NIMASA OR NPA OR FAAN OR NITDA OR FIRS OR NERC OR BPE OR NDDC'
        ),
    }

    @classmethod
    def build_queries(cls, query: str = None) -> List[str]:
        """Site-scoped Google News queries, one per search topic."""
        if query:
            return [f"{query} ({cls.SITE_FILTER})"]
        return [f"({terms}) ({cls.SITE_FILTER})" for terms in cls.SEARCH_TOPICS.values()]

    @staticmethod
    def fetch_google_news_rss(query: str = None) -> List[Dict[str, Any]]:
        """Fetches and parses articles from Google News RSS feed, targeting Nigerian PSCs, companies, and agencies."""
        logger.info("Fetching articles from Google News RSS...")

        queries = NewsIngestionService.build_queries(query)

        articles = []
        urls_processed = set()
        
        for q in queries:
            url = f"https://news.google.com/rss/search?q={requests.utils.quote(q)}&hl=en-NG&gl=NG&ceid=NG:en"
            try:
                # Fetch with an explicit timeout: feedparser's own URL fetching
                # has none, so one hanging feed would stall the whole pipeline
                resp = requests.get(url, timeout=15, headers={"User-Agent": "AURA-NewsIntel/1.0"})
                resp.raise_for_status()
                feed = feedparser.parse(resp.content)
                for entry in feed.entries:
                    if entry.link in urls_processed:
                        continue
                    urls_processed.add(entry.link)
                    
                    clean_title = html.unescape(entry.title) if hasattr(entry, 'title') and entry.title else ""
                    clean_summary = html.unescape(entry.summary) if hasattr(entry, 'summary') and entry.summary else clean_title
                    
                    articles.append({
                        "title": clean_title,
                        "url": entry.link,
                        "source": entry.source.title if hasattr(entry, 'source') else "Google News",
                        # Empty, not now(): an entry that omits a date has an
                        # unknown one, and the 48h filter excludes and logs it
                        # rather than treating this moment as its publication.
                        "published_at": entry.published if hasattr(entry, 'published') else "",
                        "raw_text": clean_summary,
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
            
            # These used to be attributed to Reuters, Bloomberg, the Financial
            # Times and the Wall Street Journal, with URLs on those newspapers'
            # own domains. Invented stories carrying a real masthead is not a
            # thing to generate under any circumstances, demo or not, and the
            # byline survived into the sheet and the executive brief with
            # nothing marking it as synthetic.
            #
            # The name now says what the row is everywhere Source is displayed,
            # which is the cheapest durable marker: it travels into the feed,
            # the article modal and the CSV export without any of them needing
            # to know about seeding.
            src = SYNTHETIC_SOURCE

            # .invalid is reserved by RFC 2606 and can never resolve, so a
            # generated link cannot be mistaken for a citation or accidentally
            # followed to somebody's real article.
            slug = headline.lower().replace(" ", "-").replace("$", "").replace(".", "")
            slug = re.sub(r'[^a-z0-9\-]', '', slug)
            url = f"https://sample.example.invalid/{pub_date.strftime('%Y/%m/%d')}/{slug}"

            articles.append({
                "title": headline,
                "url": url,
                "source": src,
                "published_at": pub_date.isoformat(),
                "raw_text": text,
                "is_rss": False,
                "is_synthetic": True,
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
        
        # 3. Padding a thin cycle with invented articles is opt-in.
        #
        # This used to fire unconditionally below ten articles -- which is
        # precisely when the fetchers are struggling: a rate-limited API, an
        # expired key, a degraded network. On exactly those days 25 fabricated
        # stories were analysed, written to the sheet, counted in the KPIs and
        # folded into the executive brief.
        #
        # A quiet news day, or a broken fetcher, is a fact the brief should
        # reflect. Padding it is the system asserting something it does not
        # know. Same reasoning as SEED_DEMO_PSC, and the same default.
        if len(all_articles) < 10:
            if settings.SEED_DEMO_ARTICLES:
                logger.warning(
                    "Only %d real article(s) collected; SEED_DEMO_ARTICLES is on, so "
                    "adding synthetic samples marked '%s'.", len(all_articles), SYNTHETIC_SOURCE
                )
                all_articles.extend(cls.generate_mock_news(25))
            else:
                logger.warning(
                    "Only %d real article(s) collected this cycle. Continuing with what "
                    "is real rather than padding. Check the source adapters and API keys "
                    "if this persists.", len(all_articles)
                )
            
        # Post-ingestion strict Nigeria filter
        # Drop site chrome before anything else. Scoping searches to gov.ng and
        # com.ng surfaces regulator *homepages* as if they were stories --
        # "Corporate Affairs Commission - Corporate Affairs Commission",
        # "Account Login", "NAICOM Home" -- and every one of them passes the
        # Nigerian check on its .ng URL, then costs an LLM call to conclude it
        # is not news.
        stubs = [a for a in all_articles if is_navigation_stub(a.get("title"), a.get("source"))]
        if stubs:
            logger.info(f"Discarded {len(stubs)} navigation/homepage entries before analysis.")
        all_articles = [a for a in all_articles if not is_navigation_stub(a.get("title"), a.get("source"))]

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
                # Word-boundary, not substring: "firs" as a bare substring
                # matches "first", "firstly", "First HoldCo" -- anything
                # containing the English word "first" would otherwise pass
                # as a Nigeria match via the FIRS acronym.
                re.search(r"\bfirs\b", title_lower) or re.search(r"\bfirs\b", text_lower) or
                "nimasa" in title_lower or "nimasa" in text_lower or
                "fgn" in title_lower or "fgn" in text_lower
            )
            if is_nigerian:
                nigerian_filtered.append(art)
                
        # 4. Limit to last 48 hours
        #
        # An article whose date cannot be established is excluded rather than
        # admitted: this filter's whole claim is "published within 48 hours",
        # and that cannot be asserted about a date we could not read. The old
        # fallback to now() made every such article pass, then float to the top
        # of a newest-first feed.
        #
        # Excluded ones are counted and logged, because dropping coverage
        # silently would only move the dishonesty rather than remove it. A
        # rising count here means a feed changed its date format.
        limit_date = datetime.now() - timedelta(hours=48)
        time_filtered = []
        undated = 0
        for art in nigerian_filtered:
            pub_date = parse_feed_date(art.get("published_at"))
            if pub_date is None:
                undated += 1
                continue
            if pub_date >= limit_date:
                time_filtered.append(art)

        if undated:
            logger.warning(
                "Excluded %d article(s) with an unreadable publication date from the 48h window; "
                "if this is climbing, a source changed its date format.", undated
            )


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

