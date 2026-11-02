"""Claude in the pipeline: used first when ANTHROPIC_API_KEY is set, never a hard dependency."""
from types import SimpleNamespace as NS

import pytest

from backend.app.core.config import settings
from backend.app.services import claude_llm
from backend.app.services.llm import LLMService


def text_reply(text, stop="end_turn", content=None):
    return NS(stop_reason=stop, content=content if content is not None else [NS(type="text", text=text)])


class FakeMessages:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class FakeClient:
    def __init__(self, replies=(), beta_replies=()):
        self.messages = FakeMessages(replies)
        self.beta = NS(messages=FakeMessages(beta_replies))


@pytest.fixture
def claude(monkeypatch):
    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(settings, "ANTHROPIC_FETCH_MAX", 2)
    claude_llm.reset_run()

    def install(client):
        monkeypatch.setattr(claude_llm, "_client", client)
        return client
    return install


def test_nothing_runs_without_a_key(monkeypatch):
    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", None)
    assert not claude_llm.configured()
    assert claude_llm.extract("s", "u") == "" and claude_llm.write("p") == ""
    assert claude_llm.fetch_article("t", "o") is None


def test_extraction_uses_haiku_with_cached_instructions(claude):
    client = claude(FakeClient([text_reply('{"relevant": true}')]))
    assert claude_llm.extract("SYSTEM", "article") == '{"relevant": true}'
    call = client.messages.calls[0]
    assert call["model"] == "claude-haiku-5-5"
    assert call["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert call["output_config"] == {"effort": "low"}


def test_writing_uses_sonnet_with_the_refusal_fallback(claude):
    client = claude(FakeClient(beta_replies=[text_reply("## Brief")]))
    assert claude_llm.write("prompt") == "## Brief"
    call = client.beta.messages.calls[0]
    assert call["model"] == "claude-sonnet-5-5"
    assert call["fallbacks"] == "default" and call["betas"] == [claude_llm.FALLBACK_BETA]


def test_a_refusal_or_an_error_is_an_empty_answer(claude):
    claude(FakeClient([text_reply("x", stop="refusal"), RuntimeError("down")]))
    assert claude_llm.extract("s", "u") == ""
    assert claude_llm.extract("s", "u") == ""


ARTICLE = ("Oyo State Governor Seyi Makinde has approved N4.6 billion as compensation for owners of 1,200 "
           "properties affected by the Circular road project. " * 4)


def test_fetching_finds_the_outlets_article_and_resumes_a_paused_turn(claude):
    paused = text_reply("", stop="pause_turn", content=[NS(type="server_tool_use")])
    found = text_reply('{"found": true, "url": "https://businessday.ng/x", "text": "%s"}' % ARTICLE)
    client = claude(FakeClient([paused, found]))
    result = claude_llm.fetch_article("Makinde approves N4.6bn compensation for Circular road owners", "businessday")
    assert result["url"] == "https://businessday.ng/x" and result["text"].startswith("Oyo State")
    first, second = client.messages.calls
    assert second["messages"][1] == {"role": "assistant", "content": paused.content}
    # The research agent runs on Haiku, with the web tools Haiku supports.
    assert first["model"] == "claude-haiku-5-5"
    assert {t["type"] for t in first["tools"]} == {"web_search_20250305", "web_fetch_20250910"}


def test_a_larger_model_gets_the_newer_web_tools():
    assert {t["type"] for t in claude_llm._web_tools("claude-sonnet-5-5", 3, 2)} == \
        {"web_search_20260209", "web_fetch_20260209"}


@pytest.mark.parametrize("reply", [
    '{"found": false}',
    '{"found": true, "url": "https://news.google.com/x", "text": "%s"}' % ARTICLE,   # not the outlet
    '{"found": true, "url": "https://punchng.com/y", "text": "Short."}',                # no body
    '{"found": true, "url": "https://punchng.com/z", "text": "%s"}' % ("Unrelated cement story. " * 40),
])
def test_a_doubtful_lookup_is_not_used(claude, reply):
    claude(FakeClient([text_reply(reply)]))
    assert claude_llm.fetch_article("Makinde approves N4.6bn compensation for Circular road owners", "businessday") is None


def test_lookups_stop_at_the_per_run_cap(claude):
    client = claude(FakeClient([text_reply('{"found": false}')] * 5))
    for _ in range(5):
        claude_llm.fetch_article("Some headline about a company", "Punch")
    assert len(client.messages.calls) == 2


def test_claude_leads_the_extraction_cascade(claude, monkeypatch):
    claude(FakeClient([text_reply('{"relevant": true, "category": "Company", "summary": "S", "risk_score": 10}')]))
    monkeypatch.setattr(LLMService, "_ollama_configured", classmethod(lambda cls: False))
    result = LLMService.analyze_article("Title", "Text")
    assert result["engine"] == "claude"


def test_the_cascade_moves_on_when_claude_fails(claude, monkeypatch):
    claude(FakeClient(beta_replies=[RuntimeError("down")]))
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "g")
    monkeypatch.setattr(LLMService, "generate_daily_report_gemini", classmethod(lambda cls, raw, prompt=None: "gemini brief"))
    assert LLMService.generate_daily_report("data") == ("gemini brief", "gemini")


def test_only_google_itself_is_refused_as_a_source(claude):
    for host, ok in (("news.google.com", False), ("google.com", False), ("notgoogle.com", True)):
        assert claude_llm._plausible({"url": f"https://{host}/a", "text": ARTICLE},
                                     "Makinde approves N4.6bn compensation for Circular road owners") is ok


def test_research_answers_with_sources(claude):
    reply = ('{"answer": "Dangote Industries holds about 86% of Dangote Cement, according to its annual report.", '
             '"sources": [{"title": "Annual report", "url": "https://dangotecement.com/ar"}, {"title": "bad", "url": "ftp://x"}], '
             '"confidence": "high"}')
    client = claude(FakeClient([text_reply(reply)]))
    result = claude_llm.research("Who owns Dangote Cement?")
    assert result["answer"].startswith("Dangote Industries") and result["confidence"] == "high"
    assert [s["url"] for s in result["sources"]] == ["https://dangotecement.com/ar"]
    assert "<question>" in client.messages.calls[0]["messages"][0]["content"]


def test_research_keeps_a_plain_text_answer_and_survives_errors(claude):
    claude(FakeClient([text_reply("No public record found."), RuntimeError("down")]))
    assert claude_llm.research("q")["answer"] == "No public record found."
    assert claude_llm.research("q") is None
    assert claude_llm.research("   ") is None
