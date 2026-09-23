"""Package 30: the news-center verticals' pure halves — Stooq/CoinGecko
parsing, market history folding, HF model/paper parsing — plus the
briefing's markets and world additions. No network anywhere.
"""
from datetime import datetime

from backend.app.services.briefing import compose_briefing, markets_line, world_lines
from backend.app.services.verticals import (
    merge_market_history,
    parse_btc,
    parse_hf_models,
    parse_hf_papers,
    parse_stooq_csv,
)

NOW = datetime(2026, 9, 23, 8, 0, 0)

STOOQ_CSV = """Symbol,Date,Time,Open,High,Low,Close,Volume
^SPX,2026-09-22,22:00:00,6470.1,6495.2,6461.0,6481.5,0
^NDX,2026-09-22,22:00:00,23800.0,23950.5,23700.2,23901.7,0
CB.F,2026-09-22,21:59:30,66.8,67.9,66.5,67.25,12345
GC.F,2026-09-22,21:59:30,2600.0,2615.0,2595.5,2611.4,54321
"""


class TestStooqParsing:
    def test_close_prices_key_to_export_names(self):
        rates = parse_stooq_csv(STOOQ_CSV)
        assert rates == {"spx": 6481.5, "ndx": 23901.7, "brent": 67.25, "gold": 2611.4}

    def test_nd_cells_and_garbage_drop_rows_not_the_batch(self):
        text = ("Symbol,Date,Time,Open,High,Low,Close,Volume\n"
                "^SPX,2026-09-22,22:00:00,N/D,N/D,N/D,N/D,0\n"
                "GC.F,2026-09-22,21:59:30,2600.0,2615.0,2595.5,2611.4,54321\n"
                "half,a,row\n")
        assert parse_stooq_csv(text) == {"gold": 2611.4}
        assert parse_stooq_csv("") == {}
        assert parse_stooq_csv("<html>proxy error</html>") == {}

    def test_unknown_symbols_ignored(self):
        text = ("Symbol,Date,Time,Open,High,Low,Close,Volume\n"
                "AAPL.US,2026-09-22,22:00:00,1,2,0.5,1.5,9\n")
        assert parse_stooq_csv(text) == {}


class TestBtcParsing:
    def test_happy_path_and_failures(self):
        assert parse_btc({"bitcoin": {"usd": 112405.33}}) == 112405.33
        assert parse_btc({"bitcoin": {"usd": 0}}) is None
        assert parse_btc({"bitcoin": {}}) is None
        assert parse_btc(None) is None


class TestMarketHistory:
    RATES = {"spx": 6481.5, "btc": 112405.33}

    def test_partial_day_is_kept_not_discarded(self):
        markets = merge_market_history(None, self.RATES, NOW)
        assert markets["latest"] == self.RATES
        assert len(markets["history"]) == 1
        assert markets["history"][0]["date"] == "2026-09-23"

    def test_same_day_rerun_replaces_and_empty_keeps_old_file(self):
        first = merge_market_history(None, self.RATES, NOW)
        second = merge_market_history(first, {"spx": 6500.0}, NOW)
        assert len(second["history"]) == 1
        assert second["latest"] == {"spx": 6500.0}
        assert merge_market_history(first, {}, NOW) is None


class TestHfParsing:
    def test_models_rows(self):
        models = parse_hf_models([
            {"id": "Qwen/Qwen3.8-27B", "likes": 16103, "downloads": 6912469,
             "pipeline_tag": "image-text-to-text"},
            {"id": "", "likes": 1}, "garbage",
        ])
        assert len(models) == 1
        m = models[0]
        assert m["url"] == "https://huggingface.co/Qwen/Qwen3.8-27B"
        assert m["task"] == "image-text-to-text"
        assert m["downloads"] == 6912469

    def test_papers_rows(self):
        papers = parse_hf_papers([
            {"paper": {"id": "2609.01234", "title": "  Ternary\n  Scaling Laws ",
                       "upvotes": 87}},
            {"paper": {"id": "", "title": "no id"}},
            {},
        ])
        assert papers == [{"title": "Ternary Scaling Laws",
                           "url": "https://huggingface.co/papers/2609.01234",
                           "upvotes": 87}]

    def test_non_list_payloads_yield_empty(self):
        assert parse_hf_models(None) == []
        assert parse_hf_papers({"error": "rate limited"}) == []


class TestBriefingMarketsAndWorld:
    MARKETS = {"latest": {"spx": 6481.5, "brent": 67.25, "btc": 112405.33},
               "history": [{"date": "2026-09-23"}]}
    WORLD = {"world": [
        {"title": "Ceasefire talks resume", "url": "https://x.test/w1", "source": "Reuters"},
        {"title": "", "url": "https://x.test/w2"},
        {"title": "Markets steady", "url": "https://x.test/w3", "source": ""},
    ]}

    def test_markets_line_formats_known_keys_only(self):
        line = markets_line(self.MARKETS)
        assert "S&P 500 6,481.50" in line
        assert "Brent $67.25" in line
        assert "BTC $112,405.33" in line
        assert "Nasdaq" not in line
        assert "(2026-09-23)" in line
        assert markets_line(None) == ""

    def test_world_lines_skip_blanks_and_cap(self):
        lines = world_lines(self.WORLD)
        assert lines == ["Ceasefire talks resume (Reuters)", "Markets steady"]
        assert world_lines(None) == []

    def test_briefing_sections_render(self):
        briefing = compose_briefing(None, None, None, {}, NOW,
                                    markets=self.MARKETS, world=self.WORLD)
        assert "MARKETS" in briefing["text"]
        assert "WORLD" in briefing["text"]
        assert "Ceasefire talks resume" in briefing["html"]
        assert "S&amp;P 500 6,481.50" in briefing["html"]
