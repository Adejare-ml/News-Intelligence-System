import os
import logging
from fastapi import APIRouter, HTTPException, Query, status, Depends, Request
from typing import List, Dict, Any, Optional
from backend.app.db.excel_db import db
from run_pipeline import run_pipeline
from backend.app.core.security import get_current_user
from backend.app.models.user import User
from backend.app.core.limiter import limiter

logger = logging.getLogger(__name__)

api_router = APIRouter(dependencies=[Depends(get_current_user)])

# ==========================================
# CRAWLER RUN TRIGGER
# ==========================================

@api_router.post("/run-news")
@limiter.limit("2/minute")
def run_news_pipeline(request: Request, seed: bool = False):
    """Triggers the complete crawling, LLM analysis, deduplication and sheets commit pipeline."""
    try:
        result = run_pipeline(seed=seed)
        return result
    except Exception as e:
        logger.error(f"Pipeline execution trigger failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Pipeline execution failed: {str(e)}")

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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
                "risk_level": "High" if int(a.get("Risk Score") or 0) >= 50 else "Low",
                "summary_executive": a.get("Summary"),
                "summary_detailed": a.get("Summary"),
                "summary_timeline": a.get("Summary"),
                "published_at": a.get("Time")
            })
            
        if category:
            normalized = [a for a in normalized if a["category"].lower() == category.lower()]
            
        return list(reversed(normalized))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ==========================================
# TRACKED ENTITIES
# ==========================================

@api_router.get("/companies")
def get_companies():
    """Lists company profiles with mention metrics and operational risk levels."""
    try:
        return db.get_companies()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/people")
def get_people():
    """Lists executive appointments, resignations, and career changes."""
    try:
        return db.get_people()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/procurement")
def get_procurement_news():
    """Lists government procurement tenders and contract awards."""
    try:
        return db.get_procurement()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
            score = int(a.get("Risk Score") or 0)
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
            score = int(a.get("Risk Score") or 0)
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
            "total_alerts": len([a for a in articles if int(a.get("Risk Score") or 0) >= 50]),
            "risk_level_counts": risk_counts,
            "category_counts": category_counts,
            "latest_alerts": latest_alerts
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ==========================================
# SYSTEM HEALTH
# ==========================================

@api_router.get("/health")
def health_check():
    """API health status verification."""
    return {"status": "healthy", "database": "sheets" if not db.use_local else "local_excel"}
