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


def _redirecting(hops):
    """A client that answers each URL in `hops` with a redirect to the next value."""
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        if url in hops:
            resp = FakeResponse("", status=301)
            resp.headers["Location"] = hops[url]
            return resp
        return FakeResponse(ARTICLE_HTML)

    get.calls = calls
    return get


def test_each_redirect_target_is_checked_against_robots_txt(monkeypatch):
    monkeypatch.setattr(fulltext, "trafilatura", None)
    # A relative Location is resolved against the page that sent it.
    get = _redirecting({"https://businessday.ng/x/": "https://amp.businessday.ng/x/",
                        "https://amp.businessday.ng/x/": "/story/"})
    robots = FakeRobots()
    text = fulltext.FullTextFetcher(get=get, robots=robots).fetch(
        "https://businessday.ng/x/", "Dangote takes control", "BusinessDay")
    assert "acquired a 60 per cent stake" in text
    assert robots.asked == ["https://businessday.ng/x/", "https://amp.businessday.ng/x/",
                            "https://amp.businessday.ng/story/"]
    assert all(kwargs["allow_redirects"] is False for _, kwargs in get.calls)


def test_a_redirect_to_a_disallowed_page_is_not_followed():
    get = _redirecting({"https://businessday.ng/x/": "https://consent.example/wall/"})
    fetcher = fulltext.FullTextFetcher(get=get, robots=FakeRobots(disallowed=("consent.example",)))
    assert fetcher.fetch("https://businessday.ng/x/", "t", "s") is None
    assert [url for url, _ in get.calls] == ["https://businessday.ng/x/"]


def test_a_redirect_loop_gives_up():
    get = _redirecting({"https://businessday.ng/a/": "https://businessday.ng/b/",
                        "https://businessday.ng/b/": "https://businessday.ng/a/"})
    fetcher = fulltext.FullTextFetcher(get=get, robots=FakeRobots())
    assert fetcher.fetch("https://businessday.ng/a/", "t", "s") is None
    assert len(get.calls) == 1 + fulltext.MAX_REDIRECTS
    assert fetcher.used == 1


def test_a_page_served_without_a_charset_is_read_as_its_own_encoding(monkeypatch):
    # requests would decode "text/html" with no charset as ISO-8859-1 and
    # garble every naira sign and curly quote before extraction.
    monkeypatch.setattr(fulltext, "trafilatura", None)
    monkeypatch.setattr(fulltext.story_detail, "detail_level", lambda *a: "full")
    resp = fulltext.requests.models.Response()
    resp.status_code = 200
    resp.headers["Content-Type"] = "text/html"
    # What requests' HTTP adapter sets from that header.
    resp.encoding = fulltext.requests.utils.get_encoding_from_headers(resp.headers)
    resp._content = ('<html><head><meta charset="utf-8"></head><body><article>'
                     "<p>Dangote’s ₦50bn stake — naira</p></article></body></html>").encode("utf-8")
    fetcher = fulltext.FullTextFetcher(get=lambda url, **k: resp, robots=FakeRobots())
    assert fetcher.fetch("https://businessday.ng/x/", "t", "s") == "Dangote’s ₦50bn stake — naira"


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
    # The server is failing: RFC 9309 says assume everything is disallowed.
    (FakeResponse("", status=500), False),
    (FakeResponse("", status=503), False),
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


# --- which stories get the budget --------------------------------------------------------------

def test_relevant_stories_come_first_riskiest_first_and_the_rest_keep_feed_order():
    analyses = [
        {"relevant": False, "risk_score": 90},
        {"relevant": True, "risk_score": 20},
        {"relevant": True, "risk_score": 80},
        {"relevant": False, "risk_score": 10},
        {"relevant": True, "risk_score": 80},
    ]
    # Ties keep feed order, so a run is reproducible.
    assert fulltext.fetch_order(analyses) == [2, 4, 1, 0, 3]


def test_the_pipeline_spends_the_full_text_budget_in_risk_order():
    import inspect
    import run_pipeline
    src = inspect.getsource(run_pipeline.run_pipeline)
    # Every snippet is extracted before any story is deepened, so the
    # riskiest relevant stories, not the first in the feed, get the fetches.
    first_extraction = src.index("LLMService.analyze_article(title, cleaned_text)")
    ordering = src.index("fulltext.fetch_order(")
    assert first_extraction < ordering < src.index("fulltext.deepen(")


# --- where the basis is kept -------------------------------------------------------------------

def test_basis_and_quote_are_appended_to_articles_and_basis_to_significant_control():
    from backend.app.db.excel_db import SHEETS_CONFIG
    # Appended, not inserted: existing rows are remapped by name, and the
    # Companies sheet shows positional writes still exist elsewhere.
    assert SHEETS_CONFIG["Articles"][-2:] == ["Basis", "Quote"]
    assert SHEETS_CONFIG["Significant Control"][-1] == "Basis"


# --- the short quote ---------------------------------------------------------------------------

FULL = ("Lagos -- Shares rose on Friday. "
        "Dangote Industries Limited has acquired a 60 per cent stake in Lagos Refinery Services, "
        "the company said. Analysts expect more deals.")


def test_the_quote_is_the_article_sentence_the_first_key_fact_restates():
    facts = ["Dangote Industries acquired a 60 per cent stake in Lagos Refinery Services."]
    assert fulltext.story_detail.quote(FULL, facts) == (
        "Dangote Industries Limited has acquired a 60 per cent stake in Lagos Refinery Services, "
        "the company said.")


def test_the_quote_is_capped_at_a_word_boundary():
    long_sentence = "Dangote Industries acquired a stake " + "in a long list of refinery assets " * 10 + "."
    text = fulltext.story_detail.quote(long_sentence, ["Dangote Industries acquired a stake in refinery assets"])
    assert len(text) <= fulltext.story_detail.MAX_QUOTE_CHARS
    assert text.endswith("…") and long_sentence.startswith(text[:-1])
    assert not text[:-1].endswith(" ")


def test_no_quote_without_a_fact_the_article_backs():
    assert fulltext.story_detail.quote(FULL, ["Zenith Bank appointed a new chairman."]) == ""
    assert fulltext.story_detail.quote(FULL, []) == ""


def test_the_pipeline_deepens_relevant_stories_and_stores_the_basis():
    import inspect
    import run_pipeline
    src = inspect.getsource(run_pipeline.run_pipeline)
    assert "fulltext.deepen(" in src
    assert src.count('"Basis": basis') == 2  # the article row and each PSC row
    # A short quote from the full article, never the article itself.
    assert '"Quote": story_detail.quote(cleaned_text, analysis["key_facts"]) if basis == "article" else ""' in src
    # The old pre-relevance Claude lookup is gone: it ran for every story.
    assert "claude_llm.fetch_article" not in src



# --- what a fetched text counts as -------------------------------------------------------------

STORY_TITLE = "Ada Obi takes 60% stake in Lagos Refinery Services"
STORY_ANALYSIS = {
    "relevant": True, "engine": "claude", "category": "Company", "risk_score": 40,
    "summary": "Ada Obi acquired a 60% stake in Lagos Refinery Services.",
    "significant_control": [{"name": "Ada Obi", "organization": "Lagos Refinery Services Ltd",
                             "nature_of_control": "Shareholding", "percentage": "60%"}],
}


def _sentences(n):
    """About n characters of article-like text that does not repeat the headline."""
    sentence = ("The refinery operator said the transaction was completed on Friday after "
                "regulators approved the transfer of shares. ")
    return (sentence * (n // len(sentence) + 1))[:n].strip()


def run_one_story(tmp_path, monkeypatch, url):
    """Run the pipeline over one relevant story naming a person as an owner;
    return the stored article and PSC rows. The caller stubs the fetch."""
    import run_pipeline as rp
    from backend.app.db.excel_db import SheetsDatabase
    from backend.app.services.ingestion import NewsIngestionService
    from backend.app.services.llm import LLMService

    d = SheetsDatabase()
    d.use_local = True
    d.local_path = str(tmp_path / "run.xlsx")
    d._cache = {}
    d._init_db()
    monkeypatch.setattr(rp, "db", d)
    monkeypatch.setattr(rp, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(NewsIngestionService, "collect_all", classmethod(lambda cls: [
        {"title": STORY_TITLE, "source": "Punch", "url": url,
         "raw_text": "Ada Obi has taken a 60% stake in Lagos Refinery Services."}]))
    monkeypatch.setattr(LLMService, "analyze_article",
                        classmethod(lambda cls, t, x: dict(STORY_ANALYSIS)))
    monkeypatch.setattr(rp, "compile_daily_report", lambda *a, **k: None)
    monkeypatch.setattr(rp, "export_static_json_database", lambda: None)
    monkeypatch.setattr("time.sleep", lambda s: None)
    rp.run_pipeline()
    return d.get_articles(), d.get_significant_control()


def run_google_news_story(tmp_path, monkeypatch, claude_text):
    """One news.google.com story whose outlet copy Claude finds as `claude_text`."""
    monkeypatch.setattr(fulltext.claude_llm, "configured", lambda: True)
    monkeypatch.setattr(fulltext.claude_llm, "fetch_article",
                        lambda title, outlet, published="": {"url": "https://punchng.com/story",
                                                             "text": claude_text})
    return run_one_story(tmp_path, monkeypatch, "https://news.google.com/rss/articles/xyz")


def assert_withheld_on_a_headline(articles, psc):
    from backend.app.services import register_quality
    assert [a["Basis"] for a in articles] == ["headline"]
    assert not articles[0]["Quote"]
    assert [r["Basis"] for r in psc] == ["headline"]
    row = register_quality.gate(psc)[0]
    assert row["Confidence"] == "Headline only"
    assert "unverified_person" in row["Quality"]
    assert register_quality.is_public(row) is False
    assert register_quality.public_rows(register_quality.gate(psc)) == []


def test_a_short_claude_lookup_is_headline_grade_and_its_person_claim_is_withheld(tmp_path, monkeypatch):
    # Claude's lookup passes on 400 characters; a teaser that size is not the
    # article, so the person it names rests on a headline and is held back.
    assert_withheld_on_a_headline(*run_google_news_story(tmp_path, monkeypatch, _sentences(600)))


def test_the_basis_is_measured_on_the_text_whatever_fetched_it(tmp_path, monkeypatch):
    # The stored basis follows the text the extraction read, not the fetch
    # path that returned it.
    monkeypatch.setattr(fulltext.FullTextFetcher, "fetch", lambda self, *a, **k: _sentences(600))
    assert_withheld_on_a_headline(*run_one_story(tmp_path, monkeypatch, "https://punchng.com/story"))


def test_a_full_claude_lookup_is_the_article(tmp_path, monkeypatch):
    from backend.app.services import register_quality
    articles, psc = run_google_news_story(tmp_path, monkeypatch, _sentences(1600))
    assert [a["Basis"] for a in articles] == ["article"]
    assert [r["Basis"] for r in psc] == ["article"]
    row = register_quality.gate(psc)[0]
    assert row["Confidence"] == "Full article"
    assert register_quality.is_public(row) is True
