# 📰 AURA — News Intelligence System

[![Python](https://img.shields.io/badge/Python-3.11-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-Scheduler-2088FF?style=flat-square&logo=githubactions&logoColor=white)](.github/workflows/news_scheduler.yml)
[![GitHub Pages](https://img.shields.io/badge/GitHub_Pages-Dashboard-222222?style=flat-square&logo=github&logoColor=white)](https://adejare-ml.github.io/News-Intelligence-System/)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

An automated intelligence pipeline that tracks **corporate ownership transparency in Nigeria** — beneficial owners (Persons with Significant Control), board changes, mergers, procurement awards, and regulatory actions — by reading the news four times a day and turning it into structured records and an executive brief.

**→ [Live dashboard](https://adejare-ml.github.io/News-Intelligence-System/)**

It runs with **no servers**: GitHub Actions is the scheduler, Google Sheets is the database, an LLM cascade does the extraction and writing, and GitHub Pages serves the dashboard. Total hosting cost is zero.

---

## 🏗️ Architecture

```
                    GitHub Actions (cron ×4 daily)
                                │
              ┌─────────────────▼─────────────────┐
              │        run_pipeline.py            │
              └─────────────────┬─────────────────┘
                                │
      ┌─────────────────────────┼─────────────────────────┐
      ▼                         ▼                         ▼
┌───────────┐          ┌────────────────┐        ┌────────────────┐
│  Sources  │          │  LLM cascade   │        │ Google Sheets  │
│ RSS +     │─────────▶│ extract → fail │───────▶│  (7 tabs, the  │
│ 4 news    │          │ over on error  │        │   database)    │
│ APIs      │          └────────────────┘        └───────┬────────┘
└───────────┘                                            │
                                                         ▼
                                            ┌────────────────────────┐
                                            │  Static JSON + report  │
                                            │  committed to main     │
                                            └───────────┬────────────┘
                                                        ▼
                                            ┌────────────────────────┐
                                            │  GitHub Pages          │
                                            │  dashboard (vanilla    │
                                            │  JS, no build step)    │
                                            └────────────────────────┘
```

**Why this shape.** The workload is four short bursts a day, not a continuous service. A cron runner that exits when it's done costs nothing and has nothing to keep alive, patch, or pay for. Sheets gives non-technical reviewers a familiar way to audit and correct records, which matters more here than query performance. A static dashboard means no API to secure or scale.

### The LLM cascade

Providers are tried in order and the first success wins:

| Stage | Order |
|:---|:---|
| **Article extraction** | Ollama → NVIDIA NIM |
| **Executive report** | Gemini → NVIDIA NIM → Ollama → OpenAI |

If **every** configured provider fails, the run raises `LLMCascadeError`, exits non-zero, and publishes nothing. This is deliberate: an earlier version silently degraded to keyword heuristics and spent days publishing sports and celebrity stories as corporate intelligence while every run showed green. Failing loudly beats publishing quietly. Each record carries an `Engine` column recording which provider produced it.

Degraded local extraction still exists for offline development, but only behind `ALLOW_HEURISTIC_FALLBACK=true`, which is never set in CI.

## ✨ Features

- **Beneficial ownership tracking** — PSC disclosures with direct/indirect ownership split, intermediate holding vehicles, PEP status, regulatory filing references, and control lineage
- **Multi-source aggregation** — Google News RSS plus NewsAPI, GNews, NewsData, and The Guardian
- **Relevance filtering** — off-topic stories are recorded as `Filtered` rather than published, and their URLs are cached so they are never re-analyzed
- **Executive reporting** — a daily Markdown brief with Key Developments, High Risk Alerts, Beneficial Ownership & PSC Disclosures, and Procurement & Board Changes, archived per run. Each edition covers the whole calendar day up to the run time (every bullet cites its source article), so the last run of the day publishes the complete daily picture rather than only its own batch
- **Knowledge graph** — entity relationship map linking people, companies, agencies, and PSC holders, with shortest-path tracing between any two entities
- **Global search & dossiers** — a Ctrl+K palette over companies, people, PSC records, articles and procurement; every entity gets a linkable dossier page (`#/company/…`, `#/person/…`, `#/agency/…`)
- **Interactive dashboard** — intelligence feed with live search and risk filtering, a sortable/paginated PSC register with per-holder dossiers, per-device watchlists and alert dismissal, and CSV export
- **Context signals** — term/category momentum over the pipeline's own articles, an r/Nigeria social column, and current Lagos/Abuja conditions, all fetched pipeline-side to keep the site's CSP locked to `'self'`
- **Syndication** — an RSS feed of every brief edition at [`data/feed.xml`](https://adejare-ml.github.io/News-Intelligence-System/data/feed.xml), and an optional high-risk webhook (Slack/Discord-compatible) gated on a repository secret
- **Provenance** — every article and report records the engine that generated it

## 🚀 Quick Start

### Run the pipeline locally

```bash
git clone https://github.com/Adejare-ml/News-Intelligence-System.git
cd News-Intelligence-System
pip install -r requirements.txt
python -m spacy download en_core_web_sm

cp .env.example .env    # then add at least one LLM key
python run_pipeline.py
```

Without Google Sheets credentials the pipeline falls back to a local Excel workbook at `backend/app/db/excel_db.xlsx`, so it runs end-to-end with no cloud setup.

### View the dashboard locally

```bash
python -m http.server 8017 --directory backend/app/static
```

Then open **`http://localhost:8017/index.html?static=1`**. The `?static=1` flag forces the serverless data mode so the dashboard reads the committed JSON files instead of expecting an API.

### Deploy your own

1. Fork the repo and enable GitHub Actions and Pages (serving from the `gh-pages` branch).
2. Create a Google service account, share a spreadsheet with it, and add the secrets below.
3. The scheduler runs at **07:00, 13:00, 17:00 and 23:00 UTC**, or trigger it manually:

```bash
gh workflow run news_scheduler.yml --ref main
```

### Configuration

Secrets and variables are read from the environment (GitHub Actions secrets in CI, `.env` locally).

| Variable | Description | Required |
|:---|:---|:---:|
| `GEMINI_API_KEY` | Primary report generator | At least one LLM key |
| `NVIDIA_API_KEY` | NVIDIA NIM, extraction + report fallback | At least one LLM key |
| `OLLAMA_API_KEY` / `OLLAMA_HOST` | Ollama cloud or self-hosted; skipped entirely when unset | At least one LLM key |
| `OPENAI_API_KEY` | Last-resort report fallback | No |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account JSON for Sheets | No — falls back to local Excel |
| `SPREADSHEET_ID` | Target spreadsheet id | No — falls back to local Excel |
| `NEWSAPI_KEY`, `NEWSDATA_KEY`, `GUARDIAN_API_KEY`, `GNEWS_KEY` | News source keys; RSS works without any | No |
| `ALERT_WEBHOOK_URL` | Slack/Discord-style webhook that receives each run's high-risk articles | No — unset means no alerts |
| `NTFY_TOPIC_URL` | ntfy.sh topic for phone push alerts on the same records ([setup](docs/NOTIFICATIONS.md)) | No — unset means no pushes |
| `SMTP_USERNAME`, `SMTP_PASSWORD`, `MAIL_TO` | Morning email briefing after the 8AM Lagos run ([setup](docs/NOTIFICATIONS.md)) | No — unset means no email |
| `GEMINI_MODEL`, `NVIDIA_MODEL`, `NVIDIA_MODEL_FALLBACK` | Pin specific models; sensible defaults otherwise | No |
| `SEED_DEMO_PSC` | Seed illustrative PSC rows when empty (default `false`) | No |
| `SEED_DEMO_ARTICLES` | Pad a thin ingestion cycle (<10 real articles) with synthetic ones, clearly marked, instead of leaving it as-is (default `false`) | No |
| `ALLOW_HEURISTIC_FALLBACK` | Permit degraded local extraction (default `false`) | No |

Model ids are configurable because pinned names get retired — `gemini-2.5-flash` was withdrawn mid-flight and returned 404 until the default became the `gemini-flash-latest` rolling alias.

## 📊 Data model

Google Sheets acts as the database. Each tab maps to a `SHEETS_CONFIG` entry in [`backend/app/db/excel_db.py`](backend/app/db/excel_db.py); column order is authoritative, since rows are appended positionally.

| Tab | Contents |
|:---|:---|
| **Articles** | Analyzed stories with category, risk score, summary, status, engine |
| **Significant Control** | PSC disclosures — 18 columns covering ownership split, holding vehicles, PEP status, filing refs |
| **Companies** / **People** / **Government Agencies** | Resolved entities with mention counts |
| **Procurement** | Contract awards: agency, contractor, amount, project |
| **Daily Reports** | Run statistics and the full generated report |

Each run exports these to `backend/app/static/data/*.json` for the dashboard and writes `report_latest.md` plus a dated archive, along with `weather.json`/`trends.json` context signals and the `feed.xml` RSS document.

## 🧪 Testing

```bash
pytest -q                    # Python suite (CI installs requirements-ci.txt)
node tests/frontend/run.js   # frontend suite, no dependencies or build step
```

Counts grow with every PR; CI runs both suites on each pull request and
keeps them blocking, so the badge state is the authoritative number.

## 📦 Tech Stack

| Layer | Technology |
|:---|:---|
| **Orchestration** | GitHub Actions (cron + `workflow_dispatch`) |
| **Pipeline** | Python 3.11, feedparser, requests |
| **Storage** | Google Sheets via gspread (local Excel fallback) |
| **NLP** | spaCy, sentence-transformers |
| **AI** | Gemini, NVIDIA NIM, Ollama, OpenAI |
| **Frontend** | Vanilla JS, Chart.js, vis-network — no build step |
| **Hosting** | GitHub Pages |

## 🐳 Optional: Docker / API mode

The repo also contains a **FastAPI + PostgreSQL + Celery + Redis** stack for running the same analysis as a live service. It is **not** what powers the live dashboard and is best treated as an alternative deployment target.

```bash
cp .env.example .env    # JWT_SECRET is required; the API refuses to start without it
docker-compose up -d    # API at http://localhost:8000, docs at /docs
```

Know before you build on it:

- **Obtaining a token:** `POST /api/v1/auth/login` with OAuth2 form fields `username` (the email) and `password` returns a JWT (rate-limited to 5/minute). Seed the admin user first by setting `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` — there are no default credentials.
- `JWT_SECRET` must be set, at least 32 characters, and not a known placeholder — the app fails fast rather than run with a forgeable auth boundary.
- **Split-brain storage, by design of history:** the API's read endpoints serve the Sheets/Excel database (the same one the pipeline writes), while the Celery tasks in this stack write `Article`/`Event`/`Alert` rows into Postgres that no endpoint currently reads. Treat Postgres as scaffolding for a future migration, not as the API's data source.
- Postgres and Redis bind to `127.0.0.1` only.

## 🔐 Security

- Untrusted article text is tag-wrapped with an explicit instruction to ignore embedded directives, and all model-derived strings are HTML-escaped before rendering
- Feed- and LLM-supplied URLs are scheme-checked and attribute-escaped; CSV exports neutralize spreadsheet formula injection
- Content Security Policy declared both as a response header (API mode) and a meta tag (Pages, which cannot set headers)
- Third-party CDN scripts are version-pinned with Subresource Integrity; third-party GitHub Actions are pinned to commit SHAs

## 📄 License

MIT — see [LICENSE](LICENSE).

---
*Built by [Adelugba Adejare](https://github.com/Adejare-ml)*
