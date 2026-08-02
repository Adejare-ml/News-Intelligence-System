import pytest
from backend.app.core.config import settings
from backend.app.services.llm import (
    LLMService,
    LLMCascadeError,
    DEFAULT_NVIDIA_MODEL,
    DEFAULT_NVIDIA_MODEL_FALLBACK,
)


@pytest.fixture
def no_providers(monkeypatch):
    """Simulate a runner with no LLM provider configured."""
    monkeypatch.setattr(settings, "GEMINI_API_KEY", None)
    monkeypatch.setattr(settings, "OPENAI_API_KEY", None)
    monkeypatch.setattr(settings, "NVIDIA_API_KEY", None)
    monkeypatch.setattr(settings, "OLLAMA_API_KEY", None)
    monkeypatch.setattr(settings, "OLLAMA_HOST", None)
    monkeypatch.setattr(settings, "ALLOW_HEURISTIC_FALLBACK", False)


def test_analyze_article_fails_red_without_providers(no_providers):
    with pytest.raises(LLMCascadeError):
        LLMService.analyze_article("Some headline", "Some body text")


def test_analyze_article_uses_heuristics_only_when_opted_in(no_providers, monkeypatch):
    monkeypatch.setattr(settings, "ALLOW_HEURISTIC_FALLBACK", True)
    sentinel = {"relevant": True, "category": "Company"}
    monkeypatch.setattr(LLMService, "_run_local_fallback", classmethod(lambda cls, t, x: dict(sentinel)))
    result = LLMService.analyze_article("Some headline", "Some body text")
    assert result["category"] == "Company"
    assert result["engine"] == "local-heuristics"


def test_ollama_skipped_when_unconfigured(no_providers, monkeypatch):
    called = {"ollama": False}

    def fake_ollama(cls, title, text):
        called["ollama"] = True
        return None

    monkeypatch.setattr(LLMService, "_run_ollama", classmethod(fake_ollama))
    with pytest.raises(LLMCascadeError):
        LLMService.analyze_article("Headline", "Body")
    assert called["ollama"] is False


def test_ollama_attempted_when_host_set(no_providers, monkeypatch):
    monkeypatch.setattr(settings, "OLLAMA_HOST", "http://localhost:11434")
    result_payload = {"relevant": True}
    monkeypatch.setattr(
        LLMService, "_run_ollama", classmethod(lambda cls, t, x: dict(result_payload))
    )
    result = LLMService.analyze_article("Headline", "Body")
    assert result["engine"] == "ollama"


def test_ollama_base_url_defaults_to_cloud_with_key_only(no_providers, monkeypatch):
    monkeypatch.setattr(settings, "OLLAMA_API_KEY", "sk-test")
    assert LLMService._ollama_configured() is True
    assert LLMService._ollama_base_url() == "https://ollama.com/v1"


def test_generate_daily_report_fails_red_without_providers(no_providers):
    with pytest.raises(LLMCascadeError):
        LLMService.generate_daily_report("[]")


def test_generate_daily_report_returns_engine(no_providers, monkeypatch):
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(
        LLMService, "generate_daily_report_gemini", classmethod(lambda cls, raw: "# Report")
    )
    md, engine = LLMService.generate_daily_report("[]")
    assert md == "# Report"
    assert engine == "gemini"


def test_nvidia_model_defaults_are_vendor_format():
    # NIM 404s on bare model names; both defaults must be vendor/model IDs.
    assert "/" in DEFAULT_NVIDIA_MODEL
    assert "/" in DEFAULT_NVIDIA_MODEL_FALLBACK
