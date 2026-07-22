from sqlalchemy import Column, Integer, String, Text, Float, DateTime, ForeignKey, Table, func
from sqlalchemy.orm import relationship
from backend.app.db.session import Base

# Association table for many-to-many relationship between Event and Entity
event_entities = Table(
    "event_entities",
    Base.metadata,
    Column("event_id", Integer, ForeignKey("events.id", ondelete="CASCADE"), primary_key=True),
    Column("entity_id", Integer, ForeignKey("entities.id", ondelete="CASCADE"), primary_key=True),
    Column("role", String(50), nullable=True) # e.g. "subject", "object", "affiliate"
)

class Event(Base):
    __tablename__ = "events"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(500), nullable=False)
    description = Column(Text, nullable=True)
    event_type = Column(String(100), index=True, nullable=False) # e.g. "Appointment", "Acquisition", etc.
    confidence_score = Column(Float, default=1.0)
    
    # Contextual data
    published_at = Column(DateTime(timezone=True), index=True, nullable=True)
    reason = Column(Text, nullable=True)
    outcome = Column(Text, nullable=True)
    location = Column(String(200), nullable=True)
    
    article_id = Column(Integer, ForeignKey("articles.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    article = relationship("Article")
    entities = relationship("Entity", secondary=event_entities, back_populates="events")
