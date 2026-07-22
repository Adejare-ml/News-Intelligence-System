import pytest
from backend.app.services.ingestion import NewsIngestionService

def test_generate_mock_news():
    mock_articles = NewsIngestionService.generate_mock_news(5)
    assert len(mock_articles) == 5
    
    for art in mock_articles:
        assert "title" in art
        assert "url" in art
        assert "source" in art
        assert "raw_text" in art
        assert "published_at" in art
        assert art["url"].startswith("https://")

def test_fetch_google_news_rss():
    # We test that the RSS method runs and returns a list.
    # It might return empty list if internet is down, but shouldn't crash.
    rss_articles = NewsIngestionService.fetch_google_news_rss()
    assert isinstance(rss_articles, list)
    if len(rss_articles) > 0:
        art = rss_articles[0]
        assert "title" in art
        assert "url" in art
        assert "source" in art

def test_fetch_guardian_news():
    # Test that fetching from the Guardian API functions correctly and retrieves articles.
    guardian_articles = NewsIngestionService.fetch_guardian_news()
    assert isinstance(guardian_articles, list)
    # Since we set the API key in settings, if internet is available and key is valid,
    # it should retrieve items. Even if empty, it shouldn't crash.

def test_fetch_newsdata_io():
    # Test that fetching from the NewsData API functions correctly.
    newsdata_articles = NewsIngestionService.fetch_newsdata_io()
    assert isinstance(newsdata_articles, list)


