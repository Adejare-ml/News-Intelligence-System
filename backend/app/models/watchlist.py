from sqlalchemy import Column, Integer, ForeignKey, DateTime, func
from sqlalchemy.orm import relationship
from backend.app.db.session import Base

class Watchlist(Base):
    __tablename__ = "watchlists"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    entity_id = Column(Integer, ForeignKey("entities.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    user = relationship("User")
    entity = relationship("Entity")
