"""First tests for the API surface (Package 18).

The auth boundary had zero coverage: no test imported routes.py, so the
login flow, the token gate on the private router, and the health probe
the Docker healthcheck now depends on were all unverified. The app under
test is assembled from the real routers with a real (sqlite, in-memory)
session -- only the database dependency is overridden.

Kept intentionally clear of backend.app.main: importing it pulls the
Celery task stack, which the CI dependency set deliberately excludes.
"""

import pytest

pytest.importorskip("sqlalchemy", reason="API deps are in requirements-ci")
pytest.importorskip("httpx", reason="TestClient transport")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from backend.app.core.config import settings  # noqa: E402

# backend.app.db.session builds its engine at import time from
# DATABASE_URL, and the postgres default makes SQLAlchemy import psycopg2
# -- which the CI dependency set deliberately excludes. Point it at
# sqlite for the import (the engine itself is never used here; every
# test session comes from the get_db override), then restore.
_REAL_DB_URL = settings.DATABASE_URL
settings.DATABASE_URL = "sqlite://"
from backend.app.db.session import get_db  # noqa: E402
settings.DATABASE_URL = _REAL_DB_URL

from backend.app.core.security import get_password_hash  # noqa: E402
from backend.app.db.base import Base  # noqa: E402
from backend.app.api.routes import api_router, public_router  # noqa: E402
from backend.app.models.user import User  # noqa: E402

TEST_SECRET = "unit-test-secret-key-0123456789abcdefghij"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", TEST_SECRET)

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    TestingSession = sessionmaker(bind=engine)

    session = TestingSession()
    session.add(User(
        email="analyst@example.test",
        hashed_password=get_password_hash("correct horse"),
        full_name="Test Analyst",
        role="admin",
        is_active=True,
    ))
    session.commit()

    app = FastAPI()
    app.include_router(api_router, prefix=settings.API_V1_STR)
    app.include_router(public_router, prefix=settings.API_V1_STR)

    def override_get_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as tc:
        yield tc
    session.close()


class TestPublicSurface:
    def test_health_is_unauthenticated(self, client):
        # The Docker healthcheck and the smoke tests probe this route; it
        # must answer without a token.
        res = client.get("/api/v1/health")
        assert res.status_code == 200
        assert res.json()["status"] == "healthy"

    def test_login_returns_a_bearer_token(self, client):
        res = client.post("/api/v1/auth/login",
                          data={"username": "analyst@example.test", "password": "correct horse"})
        assert res.status_code == 200, res.text
        body = res.json()
        assert body.get("access_token")
        assert body.get("token_type", "").lower() == "bearer"

    def test_wrong_password_is_rejected_without_detail_leak(self, client):
        res = client.post("/api/v1/auth/login",
                          data={"username": "analyst@example.test", "password": "wrong"})
        assert res.status_code == 401
        assert "correct horse" not in res.text


class TestPrivateSurface:
    def test_data_routes_require_a_token(self, client):
        res = client.get("/api/v1/dashboard")
        assert res.status_code in (401, 403), \
            "the private router must reject unauthenticated requests"

    def test_a_fresh_token_opens_the_gate(self, client):
        login = client.post("/api/v1/auth/login",
                            data={"username": "analyst@example.test", "password": "correct horse"})
        token = login.json()["access_token"]
        res = client.get("/api/v1/dashboard",
                         headers={"Authorization": f"Bearer {token}"})
        # The sheets-backed handler may 200 with data or 500 if the local
        # workbook is absent in CI -- either way it must NOT be the auth
        # rejection: the token was valid.
        assert res.status_code not in (401, 403), res.text


class TestEntityResolutionSimilarity:
    def test_similarity_orders_variants_above_strangers(self):
        from backend.app.services.entity_resolution import EntityResolutionService as ER
        close = ER._similarity("NNPC Limited", "NNPC Ltd")
        far = ER._similarity("NNPC Limited", "Access Bank")
        assert close > 0.7 > far
