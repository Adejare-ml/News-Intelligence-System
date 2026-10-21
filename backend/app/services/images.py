"""Article lead images for the published feed.

Best-effort and never load-bearing: an article without an image is shown
with a generated cover, so every failure here degrades to "no image".

Two sources, cheapest first:
1. The image URL a news API already returned with the article (NewsAPI
   `urlToImage`, GNews `image`, NewsData `image_url`, Guardian
   `thumbnail`, RSS `media:content`). Recorded at ingestion, free.
2. The publisher page's `og:image` / `twitter:image`, fetched once per
   article at export time for the few published rows still missing one.

Results live in data/article_images.json (article URL -> image URL, "" for
"looked, found nothing"), so an article is fetched at most once and the
Sheets schema does not change.
"""
import json
import logging
import os
from typing import Any, Callable, Dict, Iterable, List, Optional
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

CACHE_FILENAME = "article_images.json"
# Enough to cover a run's new articles; the cache handles the rest.
MAX_FETCHES_PER_RUN = 25
FETCH_TIMEOUT = 6
# og:image sits in <head>; there is no need to download a whole page.
MAX_HTML_BYTES = 400_000
MAX_URL_LENGTH = 2000
USER_AGENT = "Mozilla/5.0 (compatible; AURA-NewsIntel/1.0; +https://github.com/Adejare-ml/News-Intelligence-System)"

# Google News article links are JavaScript redirects: fetched server-side
# they return Google's own page, whose og:image is a Google logo.
_UNFETCHABLE_HOSTS = ("news.google.com",)

_META_KEYS = (
    ("property", "og:image:secure_url"),
    ("property", "og:image"),
    ("name", "og:image"),
    ("name", "twitter:image"),
    ("property", "twitter:image"),
    ("name", "twitter:image:src"),
)


def clean_image_url(value: Any, base_url: str = "") -> str:
    """An absolute http(s) image URL, or "" when the value is unusable."""
    text = str(value or "").strip()
    if not text or len(text) > MAX_URL_LENGTH:
        return ""
    if base_url:
        text = urljoin(base_url, text)
    if text.startswith("//"):
        text = "https:" + text
    parsed = urlparse(text)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ""
    return text


def image_from_feed_entry(entry: Any) -> str:
    """The first media URL a feedparser entry carries, if any."""
    for attr in ("media_content", "media_thumbnail"):
        for media in getattr(entry, attr, None) or []:
            url = clean_image_url((media or {}).get("url"))
            if url:
                return url
    for link in getattr(entry, "links", None) or []:
        if str((link or {}).get("type", "")).startswith("image/"):
            url = clean_image_url(link.get("href"))
            if url:
                return url
    return ""


def extract_og_image(html_text: str, page_url: str = "") -> str:
    """The page's share image from its <meta> tags, or ""."""
    if not html_text:
        return ""
    soup = BeautifulSoup(html_text, "html.parser")
    for attr, key in _META_KEYS:
        tag = soup.find("meta", attrs={attr: key})
        if tag and tag.get("content"):
            url = clean_image_url(tag["content"], page_url)
            if url:
                return url
    return ""


def is_fetchable(article_url: str) -> bool:
    parsed = urlparse(str(article_url or ""))
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return False
    host = parsed.netloc.lower()
    if host.endswith(".invalid"):
        return False
    return not any(host == h or host.endswith("." + h) for h in _UNFETCHABLE_HOSTS)


def fetch_og_image(article_url: str, timeout: float = FETCH_TIMEOUT) -> str:
    """Fetch the start of an article page and read its share image."""
    if not is_fetchable(article_url):
        return ""
    try:
        with requests.get(article_url, timeout=timeout, stream=True,
                          headers={"User-Agent": USER_AGENT,
                                   "Accept": "text/html,application/xhtml+xml"}) as resp:
            if resp.status_code != 200:
                return ""
            if "html" not in resp.headers.get("Content-Type", "html").lower():
                return ""
            chunks = []
            size = 0
            for chunk in resp.iter_content(chunk_size=16_384):
                chunks.append(chunk)
                size += len(chunk)
                if size >= MAX_HTML_BYTES:
                    break
            body = b"".join(chunks).decode(resp.encoding or "utf-8", errors="replace")
            return extract_og_image(body, resp.url or article_url)
    except Exception as exc:  # network, TLS, decoding: all mean "no image"
        # Exception class only: messages can embed full URLs.
        logger.info(f"og:image fetch failed ({type(exc).__name__}).")
        return ""


def load_cache(data_dir: str) -> Dict[str, str]:
    path = os.path.join(data_dir, CACHE_FILENAME)
    try:
        with open(path, encoding="utf-8") as f:
            payload = json.load(f)
        return {str(k): str(v or "") for k, v in payload.items()} if isinstance(payload, dict) else {}
    except (OSError, ValueError):
        return {}


def save_cache(data_dir: str, cache: Dict[str, str], keep_urls: Optional[Iterable[str]] = None) -> None:
    """Write the cache, pruned to `keep_urls` when given so it cannot grow forever."""
    if keep_urls is not None:
        keep = set(keep_urls)
        cache = {k: v for k, v in cache.items() if k in keep}
    path = os.path.join(data_dir, CACHE_FILENAME)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(cache.items())), f, indent=2)


def remember(cache: Dict[str, str], article_url: Any, image_url: Any) -> None:
    """Record an image a news API supplied; never overwrite a found image with ""."""
    key = str(article_url or "").strip()
    url = clean_image_url(image_url)
    if key and url:
        cache[key] = url


def attach_images(articles: List[Dict[str, Any]], cache: Dict[str, str],
                  fetch: Callable[[str], str] = fetch_og_image,
                  max_fetches: int = MAX_FETCHES_PER_RUN) -> int:
    """Set "Image" on each exported article row, fetching a few missing ones.

    Mutates `articles` and `cache`. Returns how many pages were fetched.
    An article already looked up (key present, even as "") is not fetched
    again.
    """
    fetched = 0
    for row in articles:
        url = str(row.get("URL", "")).strip()
        if not url:
            row["Image"] = ""
            continue
        if url not in cache and fetched < max_fetches and is_fetchable(url):
            cache[url] = fetch(url) or ""
            fetched += 1
        row["Image"] = cache.get(url, "")
    return fetched
