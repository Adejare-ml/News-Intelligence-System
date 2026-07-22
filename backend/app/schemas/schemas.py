from pydantic import BaseModel
from datetime import datetime
from typing import List, Dict, Any, Optional

# User Schemas
class UserBase(BaseModel):
    email: str
    full_name: Optional[str] = None

class UserCreate(UserBase):
    password: str

class UserLogin(BaseModel):
    email: str
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str

class UserOut(UserBase):
    id: int
    role: str
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True

# Article Schemas
class ArticleOut(BaseModel):
    id: int
    title: str
    url: str
    source: str
    summary_one_line: Optional[str] = None
    summary_executive: Optional[str] = None
    summary_detailed: Optional[str] = None
    summary_timeline: Optional[str] = None
    published_at: Optional[datetime] = None
    importance_score: float
    sentiment: str
    risk_level: str
    category: str
    created_at: datetime

    class Config:
        from_attributes = True

class SearchResultOut(BaseModel):
    article: ArticleOut
    score: float
    type: str

# Entity Schemas
class EntityOut(BaseModel):
    id: int
    name: str
    type: str # person, company, agency, organization
    description: Optional[str] = None
    aliases: List[str] = []
    industry: Optional[str] = None
    country: Optional[str] = None
    status: str
    risk_score: float
    influence_score: float
    details: Dict[str, Any] = {}
    created_at: datetime

    class Config:
        from_attributes = True

# Relationship Schemas
class RelationshipOut(BaseModel):
    id: int
    article_id: int
    subject_id: Optional[int] = None
    subject_name: str
    predicate: str
    object_id: Optional[int] = None
    object_name: str
    confidence_score: float
    created_at: datetime

    class Config:
        from_attributes = True

# Event Schemas
class EventOut(BaseModel):
    id: int
    title: str
    description: Optional[str] = None
    event_type: str
    confidence_score: float
    published_at: Optional[datetime] = None
    location: Optional[str] = None
    article_id: int
    entities: List[EntityOut] = []
    created_at: datetime

    class Config:
        from_attributes = True

# Alert Schemas
class AlertOut(BaseModel):
    id: int
    title: str
    message: str
    alert_type: str
    severity: str
    article_id: int
    entity_id: Optional[int] = None
    is_read: bool
    created_at: datetime

    class Config:
        from_attributes = True

# Dashboard & Analytics Schemas
class DashboardStats(BaseModel):
    total_articles: int
    total_entities: int
    total_events: int
    total_alerts: int
    risk_level_counts: Dict[str, int]
    category_counts: Dict[str, int]
    latest_alerts: List[AlertOut]
    top_risk_entities: List[EntityOut]
