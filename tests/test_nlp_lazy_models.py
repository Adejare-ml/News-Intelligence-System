"""The embedding model and the zero-shot classifier load on first use,
not at import: every pipeline run imports nlp_pipeline (for clean_html)
and was paying for two model loads it mostly never used.
"""
import importlib
import sys
import types

import pytest

import backend.app.services.nlp_pipeline as nlp_pipeline


@pytest.fixture
def fake_models(monkeypatch):
    built = {"embedder": 0, "classifier": 0}

    class FakeSentenceTransformer:
        def __init__(self, name):
            built["embedder"] += 1

        def encode(self, text):
            import numpy as np
            return np.zeros(3)

    def fake_pipeline(task, model=None):
        built["classifier"] += 1
        return lambda text, labels: {"labels": [labels[1]]}

    st = types.ModuleType("sentence_transformers")
    st.SentenceTransformer = FakeSentenceTransformer
    tf = types.ModuleType("transformers")
    tf.pipeline = fake_pipeline
    monkeypatch.setitem(sys.modules, "sentence_transformers", st)
    monkeypatch.setitem(sys.modules, "transformers", tf)
    importlib.reload(nlp_pipeline)
    yield built
    # Put the real (or conftest-mocked) modules back and reload, so no
    # fake model stays cached for the rest of the suite.
    monkeypatch.undo()
    importlib.reload(nlp_pipeline)


def test_import_loads_neither_model(fake_models):
    assert fake_models == {"embedder": 0, "classifier": 0}


def test_each_model_loads_once_on_first_use(fake_models):
    svc = nlp_pipeline.NLPPipelineService
    assert svc.generate_embeddings("Dangote Cement") == [0.0, 0.0, 0.0]
    svc.generate_embeddings("again")
    assert fake_models["embedder"] == 1
    assert fake_models["classifier"] == 0

    assert svc.classify_risk("EFCC probes bank") == "High"
    svc.detect_category("EFCC probes bank")
    assert fake_models["classifier"] == 1
