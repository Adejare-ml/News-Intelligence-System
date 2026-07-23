import os
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=True, extra="ignore")
    PROJECT_NAME: str = "AI-Powered News Intelligence System"
    API_V1_STR: str = "/api/v1"
    
    # Security
    JWT_SECRET: str = "supersecretjwtkeyfornewsinventorysystem123!"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7 # 1 week
    
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
    OPENAI_API_KEY: Optional[str] = None
    
    # Advanced Intelligence
    OLLAMA_HOST: str = "http://host.docker.internal:11434"
    OLLAMA_MODEL: str = "gemma4:31b-cloud"
    OLLAMA_API_KEY: Optional[str] = None
    NVIDIA_API_KEY: Optional[str] = None
    
    # Embedding Model Name
    EMBEDDING_MODEL_NAME: str = "all-MiniLM-L6-v2"

settings = Settings()
