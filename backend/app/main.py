from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
import os

from backend.app.core.config import settings
from backend.app.db.session import engine, SessionLocal
from backend.app.db.base import Base
from backend.app.api.routes import api_router
from backend.app.models.user import User
from backend.app.models.article import Article
from backend.app.core.security import get_password_hash
from backend.app.tasks.tasks import process_article_task
from backend.app.services.ingestion import NewsIngestionService

import logging

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from backend.app.core.limiter import limiter

app = FastAPI(
    title=settings.PROJECT_NAME,
    description="Continuously monitors, analyzes, and organizes news from multiple sources.",
    version="1.0.0"
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000", "https://adejare-ml.github.io"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response

# Include Router
app.include_router(api_router, prefix=settings.API_V1_STR)

def init_db():
    """Initializes the database, enabling pgvector and generating seed data if empty."""
    logger.info("Initializing database...")
    db = SessionLocal()
    try:
        # Enable pgvector extension
        db.execute(text("CREATE EXTENSION IF NOT EXISTS vector;"))
        db.commit()
        
        # Create tables
        Base.metadata.create_all(bind=engine)
        db.commit()
        
        # Check if users are empty
        if db.query(User).count() == 0:
            logger.info("Seeding default admin user...")
            admin = User(
                email="admin@newsintel.com",
                hashed_password=get_password_hash("adminpassword"),
                full_name="System Administrator",
                role="admin",
                is_active=True
            )
            db.add(admin)
            db.commit()
            logger.info("Admin user created (User: admin@newsintel.com, Pass: adminpassword)")
            
        # Check if articles are empty, seed mock news
        if db.query(Article).count() == 0:
            logger.info("Seeding initial mock articles for intelligence dashboard...")
            # We bypass celery delay and run synchronously during setup to ensure dashboard loads correctly
            mock_articles = NewsIngestionService.generate_mock_news(30)
            for art in mock_articles:
                process_article_task(art)
            logger.info("Database successfully seeded with mock intelligence data.")
            
    except Exception as e:
        logger.error(f"Error during database initialization: {e}", exc_info=True)
    finally:
        db.close()

@app.on_event("startup")
def startup_event():
    init_db()

# Mount Frontend static files
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
else:
    logger.warning(f"Static files directory not found at: {static_dir}")
