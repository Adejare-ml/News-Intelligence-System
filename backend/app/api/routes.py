import os
import logging
from fastapi import APIRouter, HTTPException, Query, status, Depends, Request
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from typing import List, Dict, Any, Optional
from backend.app.core.config import settings
from backend.app.db.excel_db import db
from backend.app.db.session import get_db
from backend.app.core.security import create_access_token, get_current_user, verify_password
from backend.app.models.user import User
from backend.app.core.limiter import limiter

# run_pipeline is imported inside its handler, not here: the module-level
# import executed run_pipeline.py (env parsing, spaCy/LLM imports) during
# FastAPI startup, so a bad EVAL_CAPTURE_RATE broke API import before any
# handler or the startup fail-fast could report anything useful.

logger = logging.getLogger(__name__)

# Every handler below re-raises HTTPException ahead of its generic handler.
# Without that, `except Exception` swallows the deliberate 404s -- starlette's
# HTTPException is an ordinary Exception subclass -- and re-raised them as 500s
# carrying "404: Report for date ... not found." as the detail. A client could
# not tell a missing report from a broken backend.
#
# The generic branch no longer returns str(e) either. That put raw internal
# exception text on the wire, which for a database or credentials failure is
# whatever the driver chose to put in the message.

api_router = APIRouter(dependencies=[Depends(get_current_user)])

# Unauthenticated surface: exactly two endpoints. Every route on api_router
# above requires a bearer token, but no route existed to *issue* one -- the
# tokenUrl advertised by OAuth2PasswordBearer pointed at a 404, and
# create_access_token had zero call sites, so the whole API was permanently
# unusable. /health lives here too: liveness must be provable without
# credentials.
public_router = APIRouter()


def _loose_int(value: Any) -> int:
    """Lenient sheet-cell parse: '62.5', '70%', 'N/A', None -> int or 0.

    The Risk Score column is not reliably numeric -- run_pipeline reads it
    three different defensive ways for exactly that reason -- and a bare
    int() here turned one text-formatted cell into a 500 for /news and
    /dashboard.
    """
    try:
        return int(float(str(value).replace("%", "").replace(",", "").strip() or 0))
    except (TypeError, ValueError):
        return 0


@public_router.post("/auth/login")
@limiter.limit("5/minute")
def login(request: Request,
          form_data: OAuth2PasswordRequestForm = Depends(),
          session: Session = Depends(get_db)):
    """Issues the bearer token every other endpoint requires.

    The generic 401 detail is deliberate: distinguishing "no such user"
    from "wrong password" confirms which emails have accounts.
    """
    user = session.query(User).filter(User.email == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user.")
    return {"access_token": create_access_token(user.id), "token_type": "bearer"}


@public_router.get("/health")
def health_check():
    """API health status verification."""
    return {"status": "healthy", "database": "sheets" if not db.use_local else "local_excel"}

# ==========================================
# CRAWLER RUN TRIGGER
# ==========================================

@api_router.post("/news/trigger-ingest")
@api_router.post("/run-news")
@limiter.limit("2/minute")
def run_news_pipeline(request: Request, seed: bool = False):
    """Triggers the complete crawling, LLM analysis, deduplication and sheets commit pipeline."""
    # The same opt-in gate collect_all() and init_db enforce: without it,
    # ?seed=true wrote 30 fabricated articles into the production sheet the
    # scheduler also writes, bypassing SEED_DEMO_ARTICLES entirely.
    if seed and not settings.SEED_DEMO_ARTICLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Synthetic seeding is disabled. Set SEED_DEMO_ARTICLES=true to permit it.",
        )
    try:
        from run_pipeline import run_pipeline
        result = run_pipeline(seed=seed)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Pipeline execution trigger failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Pipeline execution failed.")


# ==========================================
# NEWS FEED ENDPOINTS
# ==========================================

@api_router.get("/latest")
def get_latest_news():
    """Retrieves all news articles from the sheets database."""
    try:
        articles = db.get_articles()
        # Return newest first
        return list(reversed(articles))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unhandled error in %s", __name__)
        raise HTTPException(status_code=500, detail="Internal server error.")

@api_router.get("/news")
def list_news(category: Optional[str] = None):
    """Fallback compatible endpoint for articles lists."""
    try:
        articles = db.get_articles()
        normalized = []
        for a in articles:
            # Map sheet camel case columns to snake case API structure for backward compatibility
            normalized.append({
                "id": a.get("ID"),
                "title": a.get("Title"),
                "source": a.get("Source"),
                "url": a.get("URL"),
                "category": a.get("Category"),
                "risk_score": a.get("Risk Score"),
                "risk_level": "High" if _loose_int(a.get("Risk Score")) >= 50 else "Low",
                "summary_executive": a.get("Summary"),
                "summary_detailed": a.get("Summary"),
                "summary_timeline": a.get("Summary"),
                "published_at": a.get("Time")
            })
            
        if category:
            normalized = [a for a in normalized if (a["category"] or "").lower() == category.lower()]
            
        return list(reversed(normalized))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unhandled error in %s", __name__)
        raise HTTPException(status_code=500, detail="Internal server error.")

# ==========================================
# TRACKED ENTITIES
# ==========================================

@api_router.get("/companies")
def get_companies():
    """Lists company profiles with mention metrics and operational risk levels."""
    try:
        return db.get_companies()
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unhandled error in %s", __name__)
        raise HTTPException(status_code=500, detail="Internal server error.")

@api_router.get("/people")
def get_people():
    """Lists executive appointments, resignations, and career changes."""
    try:
        return db.get_people()
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unhandled error in %s", __name__)
        raise HTTPException(status_code=500, detail="Internal server error.")

@api_router.get("/procurement")
def get_procurement_news():
    """Lists government procurement tenders and contract awards."""
    try:
        return db.get_procurement()
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unhandled error in %s", __name__)
        raise HTTPException(status_code=500, detail="Internal server error.")

@api_router.get("/significant_control.json")
def get_significant_control():
    """Returns Persons with Significant Control (PSC) records."""
    try:
        return db.get_significant_control()
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unhandled error in %s", __name__)
        raise HTTPException(status_code=500, detail="Internal server error.")

# ==========================================
# DAILY INTELLIGENCE DIGESTS
# ==========================================

@api_router.get("/reports")
def get_reports():
    """Returns compiled daily intelligence summaries list."""
    try:
        reports = db.get_daily_reports()
        formatted = []
        for r in reports:
            formatted.append({
                "filename": f"report_{(r.get('Date') or '').replace('-', '')}.md",
                "created_at": f"{r.get('Date')} {r.get('Generated', '12:00').split(' ')[-1]}",
                "content": r.get("Content", "")
            })
        # Newest first
        formatted.sort(key=lambda x: x["created_at"], reverse=True)
        return formatted
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unhandled error in %s", __name__)
        raise HTTPException(status_code=500, detail="Internal server error.")

@api_router.post("/reports/trigger")
@limiter.limit("2/minute")
def trigger_report_compilation(request: Request):
    """Compiles a new daily report."""
    try:
        from run_pipeline import compile_daily_report
        # Just pass recent articles for the report
        articles = db.get_articles()
        recent = articles[-30:] if len(articles) > 30 else articles
        # Convert to expected format for compile_daily_report
        records = [{"analysis": a} for a in recent]
        compile_daily_report(records)
        return {"status": "success", "message": "Report compiled successfully."}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unhandled error in %s", __name__)
        raise HTTPException(status_code=500, detail="Internal server error.")

@api_router.get("/reports/latest")
def get_latest_report():
    """Retrieves the latest generated report markdown."""
    try:
        reports = db.get_daily_reports()
        if not reports:
            # Try loading static file
            static_report = os.path.join(os.path.dirname(__file__), "..", "static", "data", "report_latest.md")
            if os.path.exists(static_report):
                with open(static_report, "r", encoding="utf-8") as f:
                    return {"content": f.read()}
            raise HTTPException(status_code=404, detail="No daily reports found.")
            
        # Get newest row content
        latest = reports[-1]
        return {"content": latest.get("Content", "# Daily Report\n\nNo developments compiled.")}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unhandled error in %s", __name__)
        raise HTTPException(status_code=500, detail="Internal server error.")

@api_router.get("/reports/{filename}")
def get_specific_report(filename: str):
    """Retrieves a specific daily report markdown content."""
    try:
        # Extract date from report_YYYYMMDD.md -> YYYY-MM-DD
        date_raw = filename.replace("report_", "").replace(".md", "")
        target_date = f"{date_raw[0:4]}-{date_raw[4:6]}-{date_raw[6:8]}"
        
        reports = db.get_daily_reports()
        match = next((r for r in reports if r.get("Date") == target_date), None)
        if match:
            return {"content": match.get("Content", "")}
            
        raise HTTPException(status_code=404, detail=f"Report for date {target_date} not found.")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unhandled error in %s", __name__)
        raise HTTPException(status_code=500, detail="Internal server error.")

# ==========================================
# SYSTEM COMPATIBILITY ENDPOINTS
# ==========================================

@api_router.get("/dashboard")
def get_dashboard_stats():
    """Aggregates telemetry statistics directly from Google Sheets / Excel database."""
    try:
        articles = db.get_articles()
        companies = db.get_companies()
        reports = db.get_daily_reports()
        
        total_articles = len(articles)
        total_entities = len(companies)
        total_events = len([a for a in articles if a.get("Category") == "Government"])
        
        # Risk breakdowns
        risk_counts = {"Low": 0, "Medium": 0, "High": 0, "Critical": 0}
        for a in articles:
            score = _loose_int(a.get("Risk Score"))
            if score >= 75:
                risk_counts["Critical"] += 1
            elif score >= 50:
                risk_counts["High"] += 1
            elif score >= 25:
                risk_counts["Medium"] += 1
            else:
                risk_counts["Low"] += 1
                
        category_counts = {}
        for a in articles:
            cat = a.get("Category", "Other")
            category_counts[cat] = category_counts.get(cat, 0) + 1
            
        latest_alerts = []
        for a in reversed(articles):
            score = _loose_int(a.get("Risk Score"))
            if score >= 50:
                latest_alerts.append({
                    "title": f"Risk Alert: {a.get('Title')}",
                    "severity": "Critical" if score >= 75 else "Warning",
                    "message": a.get("Summary"),
                    "created_at": a.get("Time")
                })
            if len(latest_alerts) >= 10:
                break
                
        return {
            "total_articles": total_articles,
            "total_entities": total_entities,
            "total_events": total_events,
            "total_alerts": len([a for a in articles if _loose_int(a.get("Risk Score")) >= 50]),
            "risk_level_counts": risk_counts,
            "category_counts": category_counts,
            "latest_alerts": latest_alerts
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unhandled error in %s", __name__)
        raise HTTPException(status_code=500, detail="Internal server error.")

@api_router.get("/analytics")
def get_analytics():
    """Compatibility graph node endpoint."""
    try:
        static_graph = os.path.join(os.path.dirname(__file__), "..", "static", "data", "graph.json")
        if os.path.exists(static_graph):
            import json
            with open(static_graph, "r", encoding="utf-8") as f:
                return json.load(f)
        return {"nodes": [], "edges": []}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unhandled error in %s", __name__)
        raise HTTPException(status_code=500, detail="Internal server error.")

# ==========================================
# SYSTEM HEALTH
# ==========================================

# /health moved to public_router above: liveness must not require a token.
