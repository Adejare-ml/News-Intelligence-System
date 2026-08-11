import os
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=True, extra="ignore")
    PROJECT_NAME: str = "AI-Powered News Intelligence System"
    API_V1_STR: str = "/api/v1"
    
    # Security
    # No default on purpose: a public default secret lets anyone forge admin
    # tokens. The API refuses to start without one (see main.py); the
    # serverless pipeline never touches JWT and is unaffected.
    JWT_SECRET: Optional[str] = None
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 # 24 hours
    # Admin user is only seeded when this is explicitly set (no hardcoded
    # default credentials, nothing logged).
    ADMIN_SEED_EMAIL: str = "admin@newsintel.com"
    ADMIN_SEED_PASSWORD: Optional[str] = None
    
    # Databases & Caching
    DATABASE_URL: str = "postgresql://postgres:postgrespassword@localhost:5432/news_intel"
    REDIS_URL: str = "redis://localhost:6379/0"
    
    # News Provider Keys (Optional)
    NEWSAPI_KEY: Optional[str] = None
    NEWSAPI_KEY_2: Optional[str] = None
    GNEWS_KEY: Optional[str] = None
    MEDIASTACK_KEY: Optional[str] = None
    NEWSDATA_KEY: Optional[str] = None
    GUARDIAN_API_KEY: Optional[str] = None
    
    # Google Sheets Settings
    GOOGLE_SERVICE_ACCOUNT_JSON: Optional[str] = None
    SPREADSHEET_ID: Optional[str] = None
    
    # LLM Settings
    GEMINI_API_KEY: Optional[str] = None
    # Blank env values fall back to the default resolved in llm.py.
    GEMINI_MODEL: Optional[str] = None
    OPENAI_API_KEY: Optional[str] = None
    
    # Advanced Intelligence
    # OLLAMA_HOST intentionally has no default: the cascade only attempts Ollama
    # when the host or API key is explicitly configured (env or .env).
    OLLAMA_HOST: Optional[str] = None
    OLLAMA_MODEL: str = "gemma4:31b-cloud"
    OLLAMA_API_KEY: Optional[str] = None
    NVIDIA_API_KEY: Optional[str] = None
    # NVIDIA NIM model IDs must use vendor/model format; blank env values fall
    # back to the defaults resolved in llm.py.
    NVIDIA_MODEL: Optional[str] = None
    NVIDIA_MODEL_FALLBACK: Optional[str] = None

    # Pipeline behavior
    SEED_DEMO_PSC: bool = False
    ALLOW_HEURISTIC_FALLBACK: bool = False

    # DSPy extraction.
    #
    # Off by default: the typed program is a change to the step every downstream
    # product is built from, so it is opted into per environment rather than
    # switched on for everyone by a merge. When on, it runs ahead of the existing
    # cascade and falls through to it on any failure.
    USE_DSPY_EXTRACTION: bool = False
    # Which configured provider DSPy targets. Both are reached over their
    # OpenAI-compatible endpoints.
    DSPY_PROVIDER: str = "ollama"  # "ollama" | "nvidia"

    # GEPA optimisation, used only by scripts/optimise_extraction.py -- never by
    # the scheduled pipeline. GEPA's cost is many LLM calls per candidate, so the
    # budget is explicit rather than discovered on a bill.
    GEPA_MAX_METRIC_CALLS: int = 150
    GEPA_REFLECTION_MODEL: Optional[str] = None
    
    # Embedding Model Name
    EMBEDDING_MODEL_NAME: str = "all-MiniLM-L6-v2"

settings = Settings()
