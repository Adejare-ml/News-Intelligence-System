import sys
from unittest.mock import MagicMock

# 1. Mock spacy if not installed (e.g., Python 3.13 on host)
try:
    import spacy
except ImportError:
    logger_mock = MagicMock()
    
    # Mock spaCy module structure
    class MockSpacy:
        @staticmethod
        def load(*args, **kwargs):
            # Create a mock doc and return value
            mock_nlp = MagicMock()
            
            # Setup a callable that returns a mock document with sents/ents
            def mock_call(text):
                mock_doc = MagicMock()
                mock_doc.ents = []
                mock_doc.sents = []
                return mock_doc
            mock_nlp.side_effect = mock_call
            return mock_nlp

    sys.modules['spacy'] = MockSpacy()

# 2. Mock sentence_transformers if not installed
try:
    import sentence_transformers
except ImportError:
    class MockSentenceTransformersModule:
        class SentenceTransformer:
            def __init__(self, model_name=None, *args, **kwargs):
                self.model_name = model_name

            def encode(self, sentences, *args, **kwargs):
                import numpy as np
                # Return standard 384 dimensional list for all-MiniLM-L6-v2 representation
                if isinstance(sentences, list):
                    return [np.zeros(384).tolist() for _ in sentences]
                return np.zeros(384).tolist()

    sys.modules['sentence_transformers'] = MockSentenceTransformersModule()
