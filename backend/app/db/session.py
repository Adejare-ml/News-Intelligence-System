from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from backend.app.core.config import settings

# For pgvector and standard postgres we use psycopg2. The pool arguments
# only exist on queueing pools: sqlite's default pool rejects them, and
# the API test suite points DATABASE_URL at sqlite precisely so importing
# this module does not require the postgres driver.
_pool_kwargs = {}
if not settings.DATABASE_URL.startswith("sqlite"):
    _pool_kwargs = {"pool_size": 10, "max_overflow": 20}

engine = create_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True,
    **_pool_kwargs,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
