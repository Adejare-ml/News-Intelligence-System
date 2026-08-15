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
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    # Swagger/ReDoc need an inline bootstrap script and jsdelivr assets, so
    # those routes get their own policy rather than weakening the app's.
    path = request.url.path
    if path.startswith(("/docs", "/redoc", f"{settings.API_V1_STR}/openapi.json")):
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; "
            "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; "
            "img-src 'self' data: https://fastapi.tiangolo.com; "
            "frame-ancestors 'none'"
        )
    else:
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; "
            "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; "
            "font-src https://fonts.gstatic.com; "
            "img-src 'self' data:; "
            "connect-src 'self'; "
            "base-uri 'none'; "
            "object-src 'none'; "
            "form-action 'self'; "
            "frame-ancestors 'none'"
        )
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
        
        # Check if users are empty. Admin seeding requires an explicit
        # ADMIN_SEED_PASSWORD; we never ship or log default credentials.
        if db.query(User).count() == 0:
            if settings.ADMIN_SEED_PASSWORD:
                logger.info("Seeding admin user from ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD...")
                admin = User(
                    email=settings.ADMIN_SEED_EMAIL,
                    hashed_password=get_password_hash(settings.ADMIN_SEED_PASSWORD),
                    full_name="System Administrator",
                    role="admin",
                    is_active=True
                )
                db.add(admin)
                db.commit()
                logger.info(f"Admin user created: {settings.ADMIN_SEED_EMAIL}")
            else:
                logger.warning("No users exist and ADMIN_SEED_PASSWORD is not set - skipping admin seeding.")
            
        # Check if articles are empty, seed mock news. Same gate as
        # collect_all() in ingestion.py: seeding synthetic articles is an
        # explicit opt-in, not something that happens just because a fresh
        # database happens to be empty.
        if db.query(Article).count() == 0:
            if settings.SEED_DEMO_ARTICLES:
                logger.info("Seeding initial mock articles for intelligence dashboard...")
                # We bypass celery delay and run synchronously during setup to ensure dashboard loads correctly
                mock_articles = NewsIngestionService.generate_mock_news(30)
                for art in mock_articles:
                    process_article_task(art)
                logger.info("Database successfully seeded with mock intelligence data.")
            else:
                logger.info(
                    "No articles in the database and SEED_DEMO_ARTICLES is off -- "
                    "leaving it empty rather than seeding synthetic data."
                )
            
    except Exception as e:
        logger.error(f"Error during database initialization: {e}", exc_info=True)
    finally:
        db.close()

@app.on_event("startup")
def startup_event():
    # Fail fast rather than run the API with a forgeable auth boundary.
    # Known placeholder/example values are rejected too: a secret that is
    # published in this repo is no better than no secret at all.
    KNOWN_WEAK_SECRETS = {
        "generate_a_secure_random_string_here",
        "supersecretjwtkeyfornewsinventorysystem123!",
        "changeme", "secret", "your_secret_here",
    }
    secret = (settings.JWT_SECRET or "").strip()
    if not secret or secret.lower() in KNOWN_WEAK_SECRETS or len(secret) < 32:
        raise RuntimeError(
            "JWT_SECRET is missing, too short (<32 chars), or a known "
            "placeholder value. Refusing to start the API: anyone could forge "
            "authentication tokens. Generate one with: "
            "python -c \"import secrets; print(secrets.token_urlsafe(48))\""
        )
    init_db()

# Mount Frontend static files
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
else:
    logger.warning(f"Static files directory not found at: {static_dir}")
