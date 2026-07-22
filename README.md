# 📰 News Intelligence System

[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.111-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://postgresql.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)](https://docker.com)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

An automated news intelligence pipeline that aggregates, processes, and analyzes news articles using NLP and AI. Built with **FastAPI**, **PostgreSQL + pgvector**, **Celery**, and **Generative AI** for real-time news monitoring and intelligence reporting.

---

## 🏗️ Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  News APIs   │────▶│  Celery Beat  │────▶│ Celery Worker│
│  (5 sources) │     │  (Scheduler)  │     │  (Pipeline)  │
└─────────────┘     └──────────────┘     └──────┬───────┘
                                                 │
                    ┌──────────────┐     ┌───────▼───────┐
                    │   Redis      │◀───▶│   FastAPI     │
                    │   (Queue)    │     │   (REST API)  │
                    └──────────────┘     └───────┬───────┘
                                                 │
                    ┌──────────────┐     ┌───────▼───────┐
                    │  pgvector    │◀───▶│  PostgreSQL   │
                    │  (Embeddings)│     │  (Storage)    │
                    └──────────────┘     └───────────────┘
```

## ✨ Features

- **Multi-Source Aggregation**: Pulls from NewsAPI, GNews, MediaStack, NewsData, and The Guardian
- **NLP Processing**: Entity extraction, sentiment analysis, and topic classification using spaCy
- **Semantic Search**: Vector-based article similarity search via pgvector embeddings
- **AI Summarization**: Article summarization powered by Google Generative AI and OpenAI
- **Background Processing**: Asynchronous pipeline via Celery + Redis
- **REST API**: Full CRUD API with JWT authentication, rate limiting, and pagination
- **Real-time Monitoring**: Scheduled news ingestion with Celery Beat

## 🚀 Quick Start

### Prerequisites
- Docker & Docker Compose
- Python 3.10+

### Run with Docker

```bash
# Clone the repository
git clone https://github.com/Adejare-ml/News-Intelligence-System.git
cd News-Intelligence-System

# Copy environment variables
cp .env.example .env
# Edit .env with your API keys

# Start all services
docker-compose up -d

# API is available at http://localhost:8000
# Docs at http://localhost:8000/docs
```

### Environment Variables

| Variable | Description | Required |
|:---|:---|:---:|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `REDIS_URL` | Redis connection string | Yes |
| `JWT_SECRET` | Secret key for JWT tokens | Yes |
| `NEWSAPI_KEY` | NewsAPI.org API key | No |
| `GNEWS_KEY` | GNews API key | No |
| `GUARDIAN_API_KEY` | The Guardian API key | No |

## 🧪 Testing

```bash
# Run tests
pytest tests/ -v
```

## 📦 Tech Stack

| Layer | Technology |
|:---|:---|
| **Backend** | FastAPI, Celery, SQLAlchemy |
| **Database** | PostgreSQL 16 + pgvector |
| **Queue** | Redis 7 |
| **NLP** | spaCy, sentence-transformers |
| **AI** | Google Generative AI, OpenAI |
| **Auth** | JWT (PyJWT + passlib) |
| **Deploy** | Docker Compose |

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---
*Built by [Adelugba Adejare](https://github.com/Adejare-ml)*