from sqlalchemy.orm import Session
from backend.app.models.article import Article
from backend.app.services.nlp_pipeline import NLPPipelineService
from typing import List, Dict, Any
import logging

logger = logging.getLogger(__name__)

class SearchService:
    @classmethod
    def keyword_search(cls, db: Session, query: str, limit: int = 20) -> List[Article]:
        """Performs simple SQL ILIKE search across title and text."""
        return db.query(Article).filter(
            (Article.title.ilike(f"%{query}%")) | 
            (Article.raw_text.ilike(f"%{query}%"))
        ).limit(limit).all()

    @classmethod
    def semantic_search(cls, db: Session, query: str, limit: int = 20) -> List[Article]:
        """Generates query embedding and performs pgvector cosine similarity search."""
        query_embedding = NLPPipelineService.generate_embeddings(query)
        if not query_embedding:
            # Fallback to keyword if model fails to load
            return cls.keyword_search(db, query, limit)
            
        # Cosine distance order (smaller distance = more similar)
        # using the pgvector operator
        return db.query(Article).order_by(
            Article.vector_embedding.cosine_distance(query_embedding)
        ).limit(limit).all()

    @classmethod
    def hybrid_search(cls, db: Session, query: str, limit: int = 20) -> List[Dict[str, Any]]:
        """Combines keyword and semantic search results using a simple rank fusion."""
        if not query:
            # If query is empty, return latest articles
            articles = db.query(Article).order_by(Article.published_at.desc()).limit(limit).all()
            return [{"article": art, "score": 1.0, "type": "latest"} for art in articles]

        # 1. Fetch from both search models
        keyword_results = cls.keyword_search(db, query, limit * 2)
        semantic_results = cls.semantic_search(db, query, limit * 2)

        # 2. Score ranking using Reciprocal Rank Fusion (RRF)
        # score = 1 / (rank + k)
        k = 60
        scores = {}
        article_map = {}

        # Keyword rank scoring
        for rank, art in enumerate(keyword_results):
            article_map[art.id] = art
            scores[art.id] = scores.get(art.id, 0.0) + (1.0 / (rank + k))

        # Semantic rank scoring
        for rank, art in enumerate(semantic_results):
            article_map[art.id] = art
            scores[art.id] = scores.get(art.id, 0.0) + (1.0 / (rank + k))

        # 3. Sort by combined RRF score
        sorted_ids = sorted(scores.items(), key=lambda item: item[1], reverse=True)[:limit]
        
        results = []
        for art_id, score in sorted_ids:
            results.append({
                "article": article_map[art_id],
                "score": float(score),
                "type": "hybrid"
            })
            
        return results
