from sqlalchemy import Column, Integer, String, Text, DateTime, Float, func
from pgvector.sqlalchemy import Vector
from backend.app.db.session import Base

class Article(Base):
    __tablename__ = "articles"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(500), nullable=False)
    url = Column(String(1000), unique=True, index=True, nullable=False)
    source = Column(String(200), index=True, nullable=False)
    raw_text = Column(Text, nullable=False)
    cleaned_text = Column(Text, nullable=True)
    
    # AI Summaries
    summary_one_line = Column(String(500), nullable=True)
    summary_executive = Column(Text, nullable=True)
    summary_detailed = Column(Text, nullable=True)
    summary_timeline = Column(Text, nullable=True)
    
    # Metadata
    published_at = Column(DateTime(timezone=True), index=True, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # NLP metrics
    importance_score = Column(Float, default=0.0, index=True)
    sentiment = Column(String(50), default="Neutral")  # Positive, Negative, Neutral
    risk_level = Column(String(50), default="Low", index=True)  # Low, Medium, High, Critical
    category = Column(String(100), default="General", index=True) # Government, Company, Person, Legal
    
    # Semantic Search Vector (384 dims for all-MiniLM-L6-v2)
    vector_embedding = Column(Vector(384), nullable=True)
