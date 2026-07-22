from sqlalchemy import Column, Integer, String, Text, Float, DateTime, JSON, func
from sqlalchemy.orm import relationship
from backend.app.db.session import Base

class Entity(Base):
    __tablename__ = "entities"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), unique=True, index=True, nullable=False)
    type = Column(String(50), index=True, nullable=False)  # "person", "company", "agency", "organization"
    description = Column(Text, nullable=True)
    
    aliases = Column(JSON, default=list) # e.g. ["Apple Inc.", "Apple", "Apple Corp"]
    industry = Column(String(100), index=True, nullable=True)
    country = Column(String(100), index=True, nullable=True)
    status = Column(String(50), default="Active") # Active, Inactive, Merged, Suspended, etc.
    
    risk_score = Column(Float, default=0.0, index=True)      # 0 to 100
    influence_score = Column(Float, default=0.0, index=True) # 0 to 100 (mainly for people/agencies)
    
    # Store schema-less properties (e.g. CEO, board_members, subsidiaries, education, career_history)
    details = Column(JSON, default=dict)
    
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    events = relationship("Event", secondary="event_entities", back_populates="entities")
