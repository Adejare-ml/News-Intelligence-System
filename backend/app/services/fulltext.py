"""
Full article text for the stories worth reading in full.

Feeds give a headline and a snippet, and extraction from those misses the
names, stakes and amounts further down an article. Fetching every story
would be slow and impolite, so the pipeline extracts from the snippet
first, and only a story the model judged relevant is fetched -- at most
MAX_FULLTEXT per run, honouring each outlet's robots.txt -- and extracted
again from the full text.

The text is used in memory only. What reaches the sheet is what came from
it before (a summary, key facts of a sentence each) plus Basis "article",
never the article itself.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, Optional, Tuple
from urllib import robotparser
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

from backend.app.services import claude_llm, story_detail
from backend.app.services.llm import LLMCascadeError

try:  # Better at finding the story among page furniture; optional.
    import trafilatura
except ImportError:  # pragma: no cover - exercised by monkeypatching in tests
    trafilatura = None

logger = logging.getLogger(__name__)

MAX_FULLTEXT = 10
FETCH_TIMEOUT = 15
ROBOTS_TIMEOUT = 5
USER_AGENT = "AURA-NewsIntel/1.0 (+https://github.com/Adejare-ml/News-Intelligence-System)"


def extract_main_text(html: str) -> str:
    """The article's own text: trafilatura when installed, else the <p>s of <article>."""
    if trafilatura is not None:
        text = trafilatura.extract(html)
        if text:
            return text.strip()
    soup = BeautifulSoup(html or "", "html.parser")
    # <article> holds the story on most news sites; without one, every
    # paragraph is the best guess left.
    scope = soup.find("article") or soup
    paragraphs = (p.get_text(" ", strip=True) for p in scope.find_all("p"))
    return "\n".join(p for p in paragraphs if p)


class RobotsCache:
    """robots.txt per host, read once per run with a 5-second timeout."""

    def __init__(self, get: Callable[..., Any] = requests.get):
        self._get = get
        self._parsers: Dict[str, robotparser.RobotFileParser] = {}

    def allowed(self, url: str) -> bool:
        parts = urlparse(url)
        host = f"{parts.scheme}://{parts.netloc}"
        if host not in self._parsers:
            self._parsers[host] = self._load(host)
        return self._parsers[host].can_fetch(USER_AGENT, url)

    def _load(self, host: str) -> robotparser.RobotFileParser:
        parser = robotparser.RobotFileParser()
        try:
            resp = self._get(f"{host}/robots.txt", timeout=ROBOTS_TIMEOUT,
                             headers={"User-Agent": USER_AGENT})
        except requests.RequestException as exc:
            # Unable to tell what the outlet allows, so assume nothing is.
            logger.info(f"robots.txt unreadable for {host} ({type(exc).__name__}); not fetching there.")
            parser.disallow_all = True
            return parser
        # The standard library's own reading of status codes: refused means
        # stay out, missing means nothing is disallowed.
        if resp.status_code in (401, 403):
            parser.disallow_all = True
        elif resp.status_code >= 400:
            parser.allow_all = True
        else:
            parser.parse(resp.text.splitlines())
        return parser


class FullTextFetcher:
    """Fetches article text for up to `limit` stories in a run."""

    def __init__(self, limit: int = MAX_FULLTEXT, get: Callable[..., Any] = requests.get,
                 robots: Optional[RobotsCache] = None):
        self.limit = limit
        self.used = 0
        self._get = get
        self._robots = robots or RobotsCache(get)

    def fetch(self, url: str, title: str, source: str, published: str = "") -> Optional[str]:
        """The article's text, or None when it cannot or may not be read."""
        if self.used >= self.limit:
            return None
        if (urlparse(url or "").hostname or "").lower() == "news.google.com":
            # A Google News link is a redirect page, not the article. Claude
            # can look the outlet's copy up instead.
            if not claude_llm.configured():
                return None
            self.used += 1
            found = claude_llm.fetch_article(title, source, published)
            return found["text"] if found else None
        if not self._robots.allowed(url):
            return None
        self.used += 1
        try:
            resp = self._get(url, timeout=FETCH_TIMEOUT, headers={"User-Agent": USER_AGENT})
        except requests.RequestException as exc:
            logger.info(f"Full text fetch failed for {url} ({type(exc).__name__}).")
            return None
        if resp.status_code != 200 or "html" not in resp.headers.get("Content-Type", ""):
            return None
        text = extract_main_text(resp.text)
        # Less than a full article's worth is a paywall, consent wall or
        # teaser, and would read no better than the snippet already had.
        if story_detail.detail_level(text, title, source) != "full":
            return None
        return text


def deepen(analysis: Dict[str, Any], text: str, item: Dict[str, Any], fetcher: FullTextFetcher,
           analyze: Callable[[str, str], Dict[str, Any]]) -> Tuple[Dict[str, Any], str, str]:
    """(analysis, text, basis) for one story, re-extracted from the full article when possible.

    Only a story already judged relevant from its snippet is fetched. When
    the second extraction fails, the snippet's stands: a provider outage
    should cost depth, not the story.
    """
    title = item.get("title") or ""
    if analysis.get("relevant", False):
        full = fetcher.fetch(item.get("url") or "", title, item.get("source") or "",
                             item.get("published_at") or "")
        if full:
            try:
                deeper = analyze(title, full)
            except LLMCascadeError as exc:
                logger.warning(f"Full-text extraction failed for '{title[:80]}'; keeping the snippet's: {exc}")
            else:
                logger.info(f"Re-extracted '{title[:80]}' from the full article.")
                return {**deeper, "basis": "article"}, full, "article"
    return {**analysis, "basis": "headline"}, text, "headline"
