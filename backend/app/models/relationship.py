from sqlalchemy import Column, Integer, String, Float, ForeignKey, DateTime, func
from sqlalchemy.orm import relationship
from backend.app.db.session import Base

class Relationship(Base):
    __tablename__ = "relationships"

    id = Column(Integer, primary_key=True, index=True)
    article_id = Column(Integer, ForeignKey("articles.id", ondelete="CASCADE"), nullable=False)
    
    # Subject details
    subject_id = Column(Integer, ForeignKey("entities.id", ondelete="SET NULL"), nullable=True)
    subject_name = Column(String(255), nullable=False)
    
    # Predicate (relationship verb/phrase)
    predicate = Column(String(100), nullable=False) # e.g. "appointed", "acquired", "investigated", "partnered"
    
    # Object details
    object_id = Column(Integer, ForeignKey("entities.id", ondelete="SET NULL"), nullable=True)
    object_name = Column(String(255), nullable=False)
    
    confidence_score = Column(Float, default=1.0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    article = relationship("Article")
    subject_entity = relationship("Entity", foreign_keys=[subject_id])
    object_entity = relationship("Entity", foreign_keys=[object_id])
