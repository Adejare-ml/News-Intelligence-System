import os
import sys
import json
import logging
import argparse
from datetime import datetime, timedelta
from typing import List, Dict, Any

# Adjust sys.path to find backend module
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from backend.app.services.ingestion import NewsIngestionService
from backend.app.services.llm import LLMService
from backend.app.db.excel_db import db

# Setup Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger("run_pipeline")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend", "app", "static", "data")

def main():
    parser = argparse.ArgumentParser(description="AI News Intelligence Serverless Pipeline")
    parser.add_argument("--seed", action="store_true", help="Seed the database with high-fidelity mock events")
    args = parser.parse_args()
    run_pipeline(args.seed)

def run_pipeline(seed: bool = False):
    logger.info("Initializing serverless pipeline run...")
    os.makedirs(DATA_DIR, exist_ok=True)

    # 1. Fetch Candidate Articles
    if seed:
        logger.info("Demo Mode: Generating high-fidelity seed articles...")
        candidates = NewsIngestionService.generate_mock_news(30)
    else:
        logger.info("Production Mode: Aggregating feeds from RSS and API wrappers...")
        candidates = NewsIngestionService.collect_all()

    logger.info(f"Aggregated {len(candidates)} candidate articles. Deduplicating and processing...")

    # 2. Process through LLM and Write to Sheets/Excel
    articles_processed = 0
    new_articles_count = 0
    
    # Store processed records locally to build report summary
    run_records = []
    
    # Fetch existing articles once to avoid Google Sheets 429 quota exhaustion
    try:
        existing_articles = db.get_articles()
        existing_urls = {row.get("URL") for row in existing_articles if row.get("URL")}
    except Exception as e:
        logger.error(f"Failed to fetch existing articles for deduplication: {e}")
        existing_urls = set()
        
    # --- REDUNDANCY BUFFER ---
    new_candidates = [item for item in candidates if item.get("url") not in existing_urls]
    if not new_candidates:
        logger.info("Redundancy Buffer: No new articles found. Skipping LLM execution to save quota.")
        db._append_row("Daily Reports", {
            "Date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "Total Articles": 0,
            "High Risk": 0,
            "Appointments": 0,
            "Procurement": 0,
            "Generated": "No significant change. Script was run at this specific time."
        })
        return
        
    candidates = new_candidates
    
    for item in candidates:
        url = item.get("url")
        title = item.get("title")
        source = item.get("source")
        
        # Deduplication check
        if url in existing_urls:
            continue
            
        logger.info(f"Analyzing: '{title}' ({source})")
        text = item.get("raw_text") or title
        
        # Clean text basic HTML strips
        from backend.app.services.nlp_pipeline import NLPPipelineService
        cleaned_text = NLPPipelineService.clean_html(text)
        
        # Run AI LLM Extraction
        analysis = LLMService.analyze_article(title, cleaned_text)
        
        # Relevance filter check (strictly keep corporate, policy, and procurement news)
        if not analysis.get("relevant", True):
            logger.info(f"Skipping non-relevant news item: '{title}'")
            # Wait to avoid LLM quota exhaustion (Strictly <20 RPM, 3.5s sleep = ~17 RPM)
            import time
            time.sleep(3.5)
            continue
            
        # Write Article to Database
        db_article = {
            "ID": "", # Auto incremented inside ExcelDatabase
            "Time": item.get("published_at") or datetime.now().isoformat(),
            "Title": title,
            "Source": source,
            "URL": url,
            "Category": analysis.get("category", "Other"),
            "Risk Score": int(analysis.get("risk_score", 10)),
            "Summary": analysis.get("summary") or title,
            "Status": "Unread"
        }
        
        added = db.add_article(db_article)
        
        # Free Tier / Rate Limit Handling (Strictly < 20 RPM)
        import time
        time.sleep(3.5)
        
        if not added:
            continue
            
        new_articles_count += 1
        run_records.append({
            "title": title,
            "source": source,
            "url": url,
            "analysis": analysis
        })
        
        # Write Organizations/Companies
        for org in analysis.get("organizations", []):
            name = org.get("name")
            org_type = org.get("type", "company")
            
            if org_type == "company":
                db.add_company({
                    "Company": name,
                    "Industry": "General",
                    "Risk Level": analysis.get("risk_level", "Low")
                })
            elif org_type == "agency":
                db.add_agency({
                    "Agency": name,
                    "Event": analysis.get("event_type", "Directive"),
                    "Article": title
                })
                
        # Write People Updates
        for p in analysis.get("people", []):
            db.add_person({
                "Name": p.get("name"),
                "Position": p.get("position", "Director"),
                "Organization": p.get("organization", "N/A"),
                "Event": p.get("event", "appointment")
            })
            
        # Write Procurement Tenders
        proc = analysis.get("procurement")
        if proc and isinstance(proc, dict) and proc.get("agency"):
            db.add_procurement({
                "Agency": proc.get("agency"),
                "Contractor": proc.get("contractor", "TBD"),
                "Amount": proc.get("amount", "N/A"),
                "Project": proc.get("project", title),
                "Source": source
            })
            
        # Write Significant Control (PSC)
        for psc in analysis.get("significant_control", []):
            db.add_significant_control({
                "Person Name": psc.get("name"),
                "Company": psc.get("organization", "N/A"),
                "Nature of Control": psc.get("nature_of_control", "N/A"),
                "Percentage": psc.get("percentage", "N/A"),
                "Change Type": psc.get("change_type", "disclosed"),
                "Previous Holder": psc.get("previous_holder", "N/A"),
                "Date": datetime.now().strftime("%Y-%m-%d")
            })
            
        articles_processed += 1
        
        # Add to existing_urls set to prevent processing duplicate URLs within the same candidate batch
        existing_urls.add(url)
        
        # Throttle to avoid rate limiting when writing sequentially to sheets and calling Gemini
        import time
        # 4-second sleep guarantees we stay under 15 RPM (Requests Per Minute) for Gemini & Google Sheets API
        time.sleep(4.0)

    logger.info(f"Pipeline run completed. Processed {new_articles_count} new news items.")

    # 3. Compile and Write Daily Report Row
    if new_articles_count > 0 or seed:
        compile_daily_report(run_records)

    # 4. Dump Telemetry Database JSON dumps for Frontend Web Pages
    export_static_json_database()
    return {"status": "success", "processed": new_articles_count}

def compile_daily_report(records: List[Dict[str, Any]]):
    """Compiles statistics and writes the daily intelligence summary markdown."""
    now = datetime.now()
    
    total = len(records)
    high_risk_count = sum(1 for r in records if r["analysis"].get("risk_level") in ["High", "Critical"])
    appointments_count = sum(1 for r in records if r["analysis"].get("event_type") == "Appointment")
    procurement_count = sum(1 for r in records if r["analysis"].get("event_type") == "Procurement" or r["analysis"].get("procurement"))
    
    # 1. Format Markdown Report using Gemini
    logger.info("Calling Gemini API to compile rich markdown summary report...")
    # Convert records to JSON string for Gemini
    raw_json_str = json.dumps(records, default=str)
    
    generated_md = LLMService.generate_daily_report_gemini(raw_json_str)
    
    if generated_md:
        md = f"""# PSC & Company Daily Intelligence Report
**Generated on:** {now.strftime('%Y-%m-%d %H:%M:%S')} (UTC+1)
**Run Window:** Daily Crawler Exec

## Summary Statistics
- **Total Articles Processed:** {total}
- **High Risk Signals:** {high_risk_count}
- **Appointments Logged:** {appointments_count}
- **Procurement Awards:** {procurement_count}

---

{generated_md}

---
*Report compiled cloud-based by AURA Intelligence Scheduler.*"""
    else:
        # Fallback to simple report if Gemini fails
        md = f"""# PSC & Company Daily Intelligence Report
**Generated on:** {now.strftime('%Y-%m-%d %H:%M:%S')} (UTC+1)

## Summary Statistics
- Total Processed: {total}

---
*No significant alerts triggered in this run window (Gemini generation failed).*
"""

    # Save latest static markdown file
    md_path = os.path.join(DATA_DIR, "report_latest.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md)
    logger.info(f"Wrote latest report markdown to {md_path}")
    
    # Save timestamped archive markdown file
    archive_dir = os.path.join(DATA_DIR, "archives")
    os.makedirs(archive_dir, exist_ok=True)
    archive_name = f"report_{now.strftime('%Y%m%d')}.md"
    archive_path = os.path.join(archive_dir, archive_name)
    with open(archive_path, "w", encoding="utf-8") as f:
        f.write(md)
    logger.info(f"Wrote archived report markdown to {archive_path}")

    db.add_daily_report({
        "Date": now.strftime("%Y-%m-%d"),
        "Total Articles": total,
        "High Risk": high_risk_count,
        "Appointments": appointments_count,
        "Procurement": procurement_count,
        "Generated": now.strftime("%Y-%m-%d %H:%M:%S"),
        "Content": md
    })

def export_static_json_database():
    """Generates the static JSON files read by index.html / app.js."""
    logger.info("Exporting static JSON telemetry files to static assets path...")
    
    # Read database tables
    articles = db.get_articles()
    companies = db.get_companies()
    people = db.get_people()
    agencies = db.get_agencies()
    procurement = db.get_procurement()
    reports = db.get_daily_reports()

    # Sort chronological (newest first)
    articles_sorted = list(reversed(articles))[:60]
    
    # Save base files
    with open(os.path.join(DATA_DIR, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(articles_sorted, f, default=str, indent=2)
        
    with open(os.path.join(DATA_DIR, "companies.json"), "w", encoding="utf-8") as f:
        json.dump(companies, f, default=str, indent=2)
        
    with open(os.path.join(DATA_DIR, "people.json"), "w", encoding="utf-8") as f:
        json.dump(people, f, default=str, indent=2)
        
    with open(os.path.join(DATA_DIR, "procurement.json"), "w", encoding="utf-8") as f:
        json.dump(procurement, f, default=str, indent=2)
        
    with open(os.path.join(DATA_DIR, "reports.json"), "w", encoding="utf-8") as f:
        json.dump(reports, f, default=str, indent=2)

    # 3. Generate Knowledge Graph nodes and edges
    nodes = []
    edges = []
    node_keys = set()
    edge_keys = set()
    
    # Generate nodes from companies
    for row in companies[:15]:
        name = row.get("Company", "").strip()
        if name and name not in node_keys:
            node_keys.add(name)
            nodes.append({
                "id": hash(name),
                "label": name,
                "type": "company",
                "risk": row.get("Risk Level", "Low")
            })
            
    # Generate nodes from agencies
    for row in agencies[:15]:
        name = row.get("Agency", "").strip()
        if name and name not in node_keys:
            node_keys.add(name)
            nodes.append({
                "id": hash(name),
                "label": name,
                "type": "agency",
                "risk": "Low"
            })
            
    # Generate nodes and edges from People changes
    for row in people[:20]:
        person_name = row.get("Name", "").strip()
        org_name = row.get("Organization", "").strip()
        pos = row.get("Position", "Executive")
        
        if person_name:
            if person_name not in node_keys:
                node_keys.add(person_name)
                nodes.append({
                    "id": hash(person_name),
                    "label": person_name,
                    "type": "person",
                    "risk": "Low"
                })
            
            # Connect Person to Organization
            if org_name:
                if org_name not in node_keys:
                    node_keys.add(org_name)
                    nodes.append({
                        "id": hash(org_name),
                        "label": org_name,
                        "type": "company",
                        "risk": "Low"
                    })
                
                edge_key = f"{person_name}-{org_name}-works"
                if edge_key not in edge_keys:
                    edge_keys.add(edge_key)
                    edges.append({
                        "id": hash(edge_key),
                        "from": hash(person_name),
                        "to": hash(org_name),
                        "label": f"Appointed as {pos}"
                    })

    # Generate edges from Procurement
    for row in procurement[:15]:
        agency = row.get("Agency", "").strip()
        contractor = row.get("Contractor", "").strip()
        proj = row.get("Project", "Contract").strip()
        
        if agency and contractor:
            # Ensure both exist as nodes
            if agency not in node_keys:
                node_keys.add(agency)
                nodes.append({"id": hash(agency), "label": agency, "type": "agency", "risk": "Low"})
            if contractor not in node_keys:
                node_keys.add(contractor)
                nodes.append({"id": hash(contractor), "label": contractor, "type": "company", "risk": "Low"})
                
            edge_key = f"{contractor}-{agency}-contract"
            if edge_key not in edge_keys:
                edge_keys.add(edge_key)
                edges.append({
                    "id": hash(edge_key),
                    "from": hash(contractor),
                    "to": hash(agency),
                    "label": "Contract Awardee"
                })

    graph_data = {
        "nodes": nodes,
        "edges": edges
    }
    
    with open(os.path.join(DATA_DIR, "graph.json"), "w", encoding="utf-8") as f:
        json.dump(graph_data, f, default=str, indent=2)
        
    logger.info("Database dumps successfully exported to static JSON assets.")

if __name__ == "__main__":
    main()
