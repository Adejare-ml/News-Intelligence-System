"""
Pipeline correctness pack: the model may answer with nulls, feeds carry
timezone offsets, headlines share boilerplate, and providers hang.

Each class pins one verified finding:

* _validate_llm_output back-filled only *missing* keys; the system prompt
  explicitly permits "organizations": null, and a present-but-null list
  reached `for org in analysis.get("organizations", [])` as None -- a
  TypeError outside the loop's try that killed the whole run mid-batch.
* parse_feed_date truncated timezone offsets instead of converting
  (-05:00 filed 14 hours off) and returned None for ISO dates carrying a
  numeric offset, which the 48h gate then dropped as "undated".
* fuzzy dedup at ratio>=0.70 OR jaccard>=0.65 merged opposite facts:
  "acquires" vs "sells" measures 0.90 similar.
* The NVIDIA model-fallback retried on ANY exception -- auth and quota
  errors fail identically on the second model and hid the primary's error.
"""
from datetime import datetime

import pytest

from backend.app.core.config import settings
from backend.app.services.ingestion import NewsIngestionService, parse_feed_date
from backend.app.services.llm import DEFAULT_NVIDIA_MODEL, LLMService


class TestValidatorNullTolerance:
    def test_explicit_nulls_get_the_defaults(self):
        out = LLMService._validate_llm_output({
            "relevant": None,
            "organizations": None,
            "people": None,
            "significant_control": None,
            "summary": None,
        })
        assert out["relevant"] is False
        assert out["organizations"] == []
        assert out["people"] == []
        assert out["significant_control"] == []
        assert out["summary"] == ""

    def test_non_list_containers_are_coerced(self):
        out = LLMService._validate_llm_output({"relevant": True, "people": "Jane Doe"})
        assert out["people"] == []

    def test_real_values_pass_through(self):
        out = LLMService._validate_llm_output({
            "relevant": True,
            "people": [{"name": "Jane"}],
            "risk_score": 70,
        })
        assert out["relevant"] is True
        assert out["people"] == [{"name": "Jane"}]
        assert out["risk_score"] == 70

    def test_iteration_survives_a_null_heavy_response(self):
        # The exact shape the prompt invites for irrelevant articles.
        out = LLMService._validate_llm_output({
            "relevant": False, "organizations": None,
            "people": None, "significant_control": None,
        })
        for _ in out.get("organizations", []):
            pass
        for _ in out.get("people", []):
            pass


class TestFeedDateTimezones:
    def test_rfc2822_offset_is_converted_not_truncated(self):
        assert parse_feed_date("Tue, 02 Jan 2024 08:30:00 -0500") == datetime(2024, 1, 2, 13, 30)

    def test_iso_numeric_offset_parses_instead_of_dropping(self):
        assert parse_feed_date("2024-01-01T12:00:00+01:00") == datetime(2024, 1, 1, 11, 0)

    def test_trailing_z_means_utc(self):
        assert parse_feed_date("2026-08-16T06:09:20Z") == datetime(2026, 8, 16, 6, 9, 20)

    def test_gmt_rfc2822_still_reads(self):
        assert parse_feed_date("Sun, 16 Aug 2026 08:41:00 GMT") == datetime(2026, 8, 16, 8, 41)

    def test_naive_dates_pass_through_unshifted(self):
        assert parse_feed_date("2026-08-16T12:00:00") == datetime(2026, 8, 16, 12, 0)

    def test_fractional_seconds_with_offset(self):
        assert parse_feed_date("2024-01-01T12:00:00.000-05:00") == datetime(2024, 1, 1, 17, 0)

    def test_garbage_is_still_none(self):
        assert parse_feed_date("not a date") is None
        assert parse_feed_date("") is None
        assert parse_feed_date(None) is None


class TestDedupKeepsOppositeStories:
    @pytest.mark.parametrize("a,b", [
        ("Dangote Cement acquires majority stake in BUA",
         "Dangote Cement sells majority stake in BUA"),
        ("CAC unveils beneficial ownership register",
         "CAC suspends beneficial ownership register"),
        ("SEC fines Access Bank N50m", "SEC fines Zenith Bank N50m"),
        ("NNPC appoints new CEO", "NNPC appoints new CFO"),
    ])
    def test_opposite_meaning_pairs_stay_distinct(self, a, b):
        arts = [{"title": a, "url": "https://x.test/1"},
                {"title": b, "url": "https://x.test/2"}]
        assert len(NewsIngestionService.fuzzy_deduplicate_articles(arts)) == 2

    def test_reworded_copies_still_merge(self):
        arts = [
            {"title": "Dangote Cement acquires majority stake in BUA", "url": "https://x.test/1"},
            {"title": "Dangote Cement acquires majority BUA stake", "url": "https://x.test/2"},
        ]
        assert len(NewsIngestionService.fuzzy_deduplicate_articles(arts)) == 1


class TestModelUnavailableGate:
    def test_404_and_not_found_are_retryable(self):
        class E(Exception):
            status_code = 404
        assert LLMService._is_model_unavailable(E("x")) is True
        assert LLMService._is_model_unavailable(Exception("The model `m` was not found")) is True

    def test_auth_and_quota_are_not(self):
        class E(Exception):
            status_code = 429
        assert LLMService._is_model_unavailable(E("rate limit exceeded")) is False
        assert LLMService._is_model_unavailable(Exception("401 invalid api key")) is False


class TestNvidiaFallbackBehaviour:
    class _FakeResp:
        class _Choice:
            class _Msg:
                content = '{"relevant": true, "summary": "ok"}'
            message = _Msg()
        choices = [_Choice()]

    def _fake_openai(self, per_model_errors, calls, ctor_kwargs):
        fake_resp = self._FakeResp()

        class FakeClient:
            def __init__(_self, **kwargs):
                ctor_kwargs.update(kwargs)

                class Completions:
                    @staticmethod
                    def create(model, messages):
                        calls.append(model)
                        err = per_model_errors.get(model)
                        if err:
                            raise err
                        return fake_resp

                class Chat:
                    completions = Completions()
                _self.chat = Chat()
        return FakeClient

    def test_quota_error_does_not_burn_the_fallback_model(self, monkeypatch):
        import openai
        calls, kwargs = [], {}

        class Quota(Exception):
            status_code = 429
        primary = settings.NVIDIA_MODEL or DEFAULT_NVIDIA_MODEL
        monkeypatch.setattr(settings, "NVIDIA_API_KEY", "test-key")
        monkeypatch.setattr(openai, "OpenAI",
                            self._fake_openai({primary: Quota("rate limited")}, calls, kwargs))
        assert LLMService._run_nvidia("t", "x") is None
        assert len(calls) == 1, "a quota failure must not retry on the fallback model"

    def test_missing_model_falls_back_and_parses(self, monkeypatch):
        import openai
        calls, kwargs = [], {}

        class Missing(Exception):
            status_code = 404
        primary = settings.NVIDIA_MODEL or DEFAULT_NVIDIA_MODEL
        monkeypatch.setattr(settings, "NVIDIA_API_KEY", "test-key")
        monkeypatch.setattr(openai, "OpenAI",
                            self._fake_openai({primary: Missing("model not found")}, calls, kwargs))
        out = LLMService._run_nvidia("t", "x")
        assert out["relevant"] is True
        assert len(calls) == 2

    def test_client_gets_an_explicit_deadline(self, monkeypatch):
        import openai
        calls, kwargs = [], {}
        monkeypatch.setattr(settings, "NVIDIA_API_KEY", "test-key")
        monkeypatch.setattr(openai, "OpenAI", self._fake_openai({}, calls, kwargs))
        LLMService._run_nvidia("t", "x")
        assert kwargs.get("timeout") == 60.0
        assert kwargs.get("max_retries") == 1


class TestHeuristicFallbackIsValidated:
    def test_fallback_result_carries_the_full_schema(self, monkeypatch):
        monkeypatch.setattr(settings, "USE_DSPY_EXTRACTION", False)
        monkeypatch.setattr(settings, "NVIDIA_API_KEY", "")
        monkeypatch.setattr(settings, "ALLOW_HEURISTIC_FALLBACK", True)
        monkeypatch.setattr(LLMService, "_ollama_configured", classmethod(lambda cls: False))
        out = LLMService.analyze_article("NNPC announces board change",
                                         "NNPC announced a change to its board in Abuja.")
        assert out["engine"] == "local-heuristics"
        assert "relevant" in out
        assert isinstance(out["significant_control"], list)
