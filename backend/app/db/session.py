from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from backend.app.core.config import settings

# For pgvector and standard postgres we use psycopg2
engine = create_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
