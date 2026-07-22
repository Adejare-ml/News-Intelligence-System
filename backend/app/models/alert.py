from sqlalchemy import Column, Integer, String, Text, Boolean, ForeignKey, DateTime, func
from sqlalchemy.orm import relationship
from backend.app.db.session import Base

class Alert(Base):
    __tablename__ = "alerts"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(255), nullable=False)
    message = Column(Text, nullable=False)
    alert_type = Column(String(100), index=True, nullable=False) # "New Appointment", "High Risk", "M&A", "Regulatory"
    severity = Column(String(50), default="Info", index=True) # "Info", "Warning", "Critical"
    
    article_id = Column(Integer, ForeignKey("articles.id", ondelete="CASCADE"), nullable=False)
    entity_id = Column(Integer, ForeignKey("entities.id", ondelete="CASCADE"), nullable=True)
    
    is_read = Column(Boolean, default=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    article = relationship("Article")
    entity = relationship("Entity")
