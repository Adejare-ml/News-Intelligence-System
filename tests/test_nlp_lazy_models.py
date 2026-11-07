"""The embedding model and the zero-shot classifier load on first use,
not at import: every pipeline run imports nlp_pipeline (for clean_html)
and was paying for two model loads it mostly never used.
"""
import os
import subprocess
import sys
import types

import pytest

import backend.app.services.nlp_pipeline as nlp_pipeline

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# A fresh interpreter, so the import really runs (reloading the module in
# this process would hand other modules a stale NLPPipelineService).
IMPORT_PROBE = """
import sys, types
built = []
st = types.ModuleType("sentence_transformers")
st.SentenceTransformer = lambda *a, **k: built.append("embedder")
tf = types.ModuleType("transformers")
tf.pipeline = lambda *a, **k: built.append("classifier")
sp = types.ModuleType("spacy")
sp.load = lambda *a, **k: None
sys.modules.update({"sentence_transformers": st, "transformers": tf, "spacy": sp})
import backend.app.services.nlp_pipeline
print(built)
"""


def test_import_loads_neither_model():
    out = subprocess.run([sys.executable, "-c", IMPORT_PROBE], cwd=ROOT,
                         capture_output=True, text=True, check=True)
    assert out.stdout.strip().splitlines()[-1] == "[]"


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
    monkeypatch.setattr(nlp_pipeline, "_embedding_model", nlp_pipeline._UNLOADED)
    monkeypatch.setattr(nlp_pipeline, "_classifier_pipeline", nlp_pipeline._UNLOADED)
    return built


def test_each_model_loads_once_on_first_use(fake_models):
    svc = nlp_pipeline.NLPPipelineService
    assert svc.generate_embeddings("Dangote Cement") == [0.0, 0.0, 0.0]
    svc.generate_embeddings("again")
    assert fake_models["embedder"] == 1
    assert fake_models["classifier"] == 0

    assert svc.classify_risk("EFCC probes bank") == "High"
    svc.detect_category("EFCC probes bank")
    assert fake_models["classifier"] == 1
