"""Full article text for the stories judged relevant.

Fixture HTML, a fake robots.txt and a fake HTTP client: no network.
"""
import pytest

from backend.app.services import fulltext
from backend.app.services.llm import LLMCascadeError

PARAGRAPH = (
    "Dangote Industries Limited has acquired a 60 per cent stake in Lagos Refinery Services, "
    "the company said in a filing with the Nigerian Exchange on Friday, giving it control of the "
    "operator. "
)
ARTICLE_HTML = f"""<html><head><title>Story</title></head><body>
<nav><p>Home | Business | Politics</p></nav>
<article><h1>Dangote takes control</h1>
{''.join(f'<p>{PARAGRAPH}Paragraph {i}.</p>' for i in range(10))}
</article>
<footer><p>Copyright the outlet</p></footer>
</body></html>"""


class FakeResponse:
    def __init__(self, text="", status=200, content_type="text/html; charset=utf-8"):
        self.text = text
        self.status_code = status
        self.headers = {"Content-Type": content_type}


class FakeRobots:
    """Allows everything except the paths listed."""

    def __init__(self, disallowed=()):
        self.disallowed = disallowed
        self.asked = []

    def allowed(self, url):
        self.asked.append(url)
        return not any(d in url for d in self.disallowed)


@pytest.fixture
def http():
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse(ARTICLE_HTML)

    get.calls = calls
    return get


# --- extraction --------------------------------------------------------------------------------

def test_the_fallback_reads_the_article_paragraphs_and_skips_the_page_chrome(monkeypatch):
    monkeypatch.setattr(fulltext, "trafilatura", None)
    text = fulltext.extract_main_text(ARTICLE_HTML)
    assert "acquired a 60 per cent stake" in text
    assert "Home | Business" not in text
    assert "Copyright" not in text


def test_without_an_article_element_every_paragraph_is_read(monkeypatch):
    monkeypatch.setattr(fulltext, "trafilatura", None)
    html = f"<html><body><div><p>{PARAGRAPH}</p><p>Second paragraph.</p></div></body></html>"
    assert fulltext.extract_main_text(html) == f"{PARAGRAPH.strip()}\nSecond paragraph."


def test_trafilatura_is_used_when_installed(monkeypatch):
    class FakeTrafilatura:
        @staticmethod
        def extract(html):
            return "main text from trafilatura"

    monkeypatch.setattr(fulltext, "trafilatura", FakeTrafilatura)
    assert fulltext.extract_main_text(ARTICLE_HTML) == "main text from trafilatura"


# --- fetching ----------------------------------------------------------------------------------

def test_an_allowed_article_is_fetched_politely(http, monkeypatch):
    monkeypatch.setattr(fulltext, "trafilatura", None)
    fetcher = fulltext.FullTextFetcher(get=http, robots=FakeRobots())
    text = fetcher.fetch("https://businessday.ng/news/dangote/", "Dangote takes control", "BusinessDay")
    assert "acquired a 60 per cent stake" in text
    url, kwargs = http.calls[0]
    assert url == "https://businessday.ng/news/dangote/"
    assert kwargs["timeout"] == 15
    assert "AURA" in kwargs["headers"]["User-Agent"]


def test_robots_txt_is_respected(http):
    robots = FakeRobots(disallowed=("/premium/",))
    fetcher = fulltext.FullTextFetcher(get=http, robots=robots)
    assert fetcher.fetch("https://businessday.ng/premium/story/", "t", "s") is None
    assert http.calls == []
    # A refusal costs no fetch from the run's budget.
    assert fetcher.used == 0


def test_at_most_max_fulltext_fetches_per_run(http, monkeypatch):
    monkeypatch.setattr(fulltext, "trafilatura", None)
    fetcher = fulltext.FullTextFetcher(get=http, robots=FakeRobots(), limit=2)
    results = [fetcher.fetch(f"https://businessday.ng/{i}/", "t", "s") for i in range(4)]
    assert [bool(r) for r in results] == [True, True, False, False]
    assert len(http.calls) == 2
    assert fulltext.MAX_FULLTEXT == 10


@pytest.mark.parametrize("response", [
    FakeResponse(ARTICLE_HTML, status=404),
    FakeResponse("%PDF-1.7", content_type="application/pdf"),
    # A paywall or consent page: too little text to be the article.
    FakeResponse("<html><body><article><p>Subscribe to read.</p></article></body></html>"),
])
def test_a_page_that_is_not_the_article_gives_nothing(response, monkeypatch):
    monkeypatch.setattr(fulltext, "trafilatura", None)
    fetcher = fulltext.FullTextFetcher(get=lambda url, **k: response, robots=FakeRobots())
    assert fetcher.fetch("https://businessday.ng/x/", "t", "s") is None


def test_a_network_error_gives_nothing():
    def get(url, **kwargs):
        raise fulltext.requests.ConnectionError("down")

    fetcher = fulltext.FullTextFetcher(get=get, robots=FakeRobots())
    assert fetcher.fetch("https://businessday.ng/x/", "t", "s") is None


def test_google_news_links_go_to_the_claude_lookup_not_a_direct_fetch(http, monkeypatch):
    # A news.google.com link is a redirect page, not the outlet's article.
    seen = {}

    def lookup(title, outlet, published=""):
        seen.update(title=title, outlet=outlet, published=published)
        return {"url": "https://punchng.com/story", "text": "full report"}

    monkeypatch.setattr(fulltext.claude_llm, "configured", lambda: True)
    monkeypatch.setattr(fulltext.claude_llm, "fetch_article", lookup)
    fetcher = fulltext.FullTextFetcher(get=http, robots=FakeRobots())
    text = fetcher.fetch("https://news.google.com/rss/articles/abc", "Headline", "Punch", "2026-11-06")
    assert text == "full report"
    assert seen == {"title": "Headline", "outlet": "Punch", "published": "2026-11-06"}
    assert http.calls == []
    # One run budget covers both kinds of fetch.
    assert fetcher.used == 1


def test_google_news_links_give_nothing_without_claude(http, monkeypatch):
    monkeypatch.setattr(fulltext.claude_llm, "configured", lambda: False)
    fetcher = fulltext.FullTextFetcher(get=http, robots=FakeRobots())
    assert fetcher.fetch("https://news.google.com/rss/articles/abc", "t", "s") is None
    assert http.calls == []


# --- robots.txt cache --------------------------------------------------------------------------

def test_robots_txt_is_read_once_per_host_with_a_short_timeout():
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs["timeout"]))
        return FakeResponse("User-agent: *\nDisallow: /private/\n", content_type="text/plain")

    robots = fulltext.RobotsCache(get=get)
    assert robots.allowed("https://businessday.ng/news/a/")
    assert not robots.allowed("https://businessday.ng/private/b/")
    assert robots.allowed("https://www.thecable.ng/c/")
    assert calls == [("https://businessday.ng/robots.txt", 5), ("https://www.thecable.ng/robots.txt", 5)]


@pytest.mark.parametrize("response, allowed", [
    (FakeResponse("", status=404), True),   # no robots.txt: nothing is disallowed
    (FakeResponse("", status=403), False),  # robots.txt itself refused: stay out
])
def test_robots_txt_status_codes(response, allowed):
    robots = fulltext.RobotsCache(get=lambda url, **k: response)
    assert robots.allowed("https://businessday.ng/news/a/") is allowed


def test_an_unreadable_robots_txt_means_no_fetch():
    def get(url, **kwargs):
        raise fulltext.requests.Timeout("slow")

    assert fulltext.RobotsCache(get=get).allowed("https://businessday.ng/news/a/") is False


# --- re-extraction -----------------------------------------------------------------------------

class StubFetcher:
    def __init__(self, text):
        self.text = text

    def fetch(self, url, title, source, published=""):
        return self.text


def test_a_relevant_story_is_re_extracted_from_the_full_text():
    analyses = []

    def analyze(title, text):
        analyses.append(text)
        return {"relevant": True, "summary": "from the article"}

    analysis, text, basis = fulltext.deepen(
        {"relevant": True, "summary": "from the snippet"}, "snippet",
        {"url": "https://businessday.ng/x/", "title": "t", "source": "s"},
        StubFetcher("the whole article"), analyze)
    assert analyses == ["the whole article"]
    assert analysis == {"relevant": True, "summary": "from the article", "basis": "article"}
    assert (text, basis) == ("the whole article", "article")


def test_a_story_without_full_text_keeps_its_snippet_extraction():
    snippet_analysis = {"relevant": True}
    analysis, text, basis = fulltext.deepen(
        snippet_analysis, "snippet", {"url": "u", "title": "t", "source": "s"},
        StubFetcher(None), lambda t, x: pytest.fail("no second extraction"))
    assert (analysis, text, basis) == ({"relevant": True, "basis": "headline"}, "snippet", "headline")


def test_an_irrelevant_story_is_not_fetched():
    class Refuse:
        def fetch(self, *a, **k):
            pytest.fail("an irrelevant story must not be fetched")

    analysis, _, basis = fulltext.deepen({"relevant": False}, "snippet",
                                         {"url": "u", "title": "t", "source": "s"},
                                         Refuse(), lambda t, x: {})
    assert basis == "headline" and analysis["basis"] == "headline"


def test_a_failed_second_extraction_keeps_the_snippet_one():
    def analyze(title, text):
        raise LLMCascadeError("providers down")

    analysis, text, basis = fulltext.deepen({"relevant": True}, "snippet",
                                            {"url": "u", "title": "t", "source": "s"},
                                            StubFetcher("the whole article"), analyze)
    assert (text, basis) == ("snippet", "headline")
