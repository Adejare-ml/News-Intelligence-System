import os
import sys
import json
import logging
import argparse
from datetime import datetime, timedelta
from typing import List, Dict, Any

# Adjust sys.path to find backend module
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from backend.app.core.config import settings
from backend.app.services.ingestion import NewsIngestionService
from backend.app.services.llm import LLMService, LLMCascadeError
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

# Abort the run after this many articles in a row fail the whole LLM cascade:
# at that point the providers are down and continuing would only burn quota.
MAX_CONSECUTIVE_LLM_FAILURES = 3

def main():
    parser = argparse.ArgumentParser(description="AI News Intelligence Serverless Pipeline")
    parser.add_argument("--seed", action="store_true", help="Seed the database with high-fidelity mock events")
    args = parser.parse_args()
    try:
        run_pipeline(args.seed)
    except LLMCascadeError as e:
        logger.error(f"Pipeline failed: {e}")
        sys.exit(1)

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
    
    cascade_failures = 0
    consecutive_failures = 0

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

        # Run AI LLM Extraction. A cascade failure skips the article entirely
        # (no junk row, URL left uncached so a later healthy run retries it).
        try:
            analysis = LLMService.analyze_article(title, cleaned_text)
        except LLMCascadeError as e:
            cascade_failures += 1
            consecutive_failures += 1
            logger.error(f"LLM cascade failed for '{title}': {e}")
            if consecutive_failures >= MAX_CONSECUTIVE_LLM_FAILURES:
                logger.error(
                    f"{MAX_CONSECUTIVE_LLM_FAILURES} consecutive LLM cascade failures - "
                    "providers appear to be down. Aborting article loop."
                )
                break
            continue
        consecutive_failures = 0

        # Relevance filter check (strictly keep corporate, policy, and procurement news)
        if not analysis.get("relevant", True):
            logger.info(f"Skipping non-relevant news item and logging URL to prevention cache: '{title}'")
            db.add_article({
                "ID": "",
                "Time": item.get("published_at") or datetime.now().isoformat(),
                "Title": title,
                "Source": source,
                "URL": url,
                "Category": "Non-Relevant",
                "Risk Score": 0,
                "Summary": title,
                "Status": "Filtered",
                "Engine": analysis.get("engine", "")
            })
            existing_urls.add(url)
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
            "Status": "Unread",
            "Engine": analysis.get("engine", "")
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

    # Fail red when the LLM cascade was broken for the whole run: nothing was
    # published, and the workflow should surface the outage instead of going green.
    if cascade_failures > 0 and new_articles_count == 0:
        raise LLMCascadeError(
            f"All {cascade_failures} analyzed articles failed the LLM provider cascade. "
            "No junk was published; fix the provider keys and re-run."
        )

    # 3. Compile and Write Daily Report Row
    if new_articles_count > 0 or seed:
        compile_daily_report(run_records)

    # 4. Dump Telemetry Database JSON dumps for Frontend Web Pages
    export_static_json_database()

    # Partial cascade failures: real articles were published above, but the run
    # still fails red so the degraded provider chain gets noticed.
    if cascade_failures > 0:
        raise LLMCascadeError(
            f"{cascade_failures} article(s) failed the LLM provider cascade this run "
            f"({new_articles_count} succeeded). Failing the run so the outage is visible."
        )

    return {"status": "success", "processed": new_articles_count}

def compile_daily_report(records: List[Dict[str, Any]]):
    """Compiles statistics and writes the daily intelligence summary markdown."""
    now = datetime.now()
    
    total = len(records)
    high_risk_count = sum(1 for r in records if r["analysis"].get("risk_level") in ["High", "Critical"])
    appointments_count = sum(1 for r in records if r["analysis"].get("event_type") == "Appointment")
    procurement_count = sum(1 for r in records if r["analysis"].get("event_type") == "Procurement" or r["analysis"].get("procurement"))
    
    logger.info("Calling LLM API (Gemini -> NVIDIA -> Ollama -> OpenAI) to compile rich markdown summary report...")
    # Convert records to JSON string for LLM
    raw_json_str = json.dumps(records, default=str)

    try:
        generated_md, report_engine = LLMService.generate_daily_report(raw_json_str)
    except LLMCascadeError:
        if not settings.ALLOW_HEURISTIC_FALLBACK:
            # Fail red: no templated junk report is written or published.
            raise
        logger.warning("All report providers failed. ALLOW_HEURISTIC_FALLBACK is on; writing deterministic rule-based report.")
        generated_md, report_engine = "", "rule-based"

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
*Report compiled cloud-based by AURA Intelligence Scheduler (engine: {report_engine}).*"""
    else:
        # Fallback to deterministic rule-based executive summary report if Gemini API is offline/rate-limited
        high_risk_items = [r for r in records if r.get("analysis", {}).get("risk_level") in ["High", "Critical"]]
        key_items = [r for r in records if r.get("analysis", {}).get("risk_level") not in ["High", "Critical"]][:8]
        appointments = [r for r in records if r.get("analysis", {}).get("event_type") == "Appointment"]
        procurement = [r for r in records if r.get("analysis", {}).get("event_type") == "Procurement" or r.get("analysis", {}).get("procurement")]
        
        key_dev_lines = []
        for item in key_items:
            title = item.get("title", "Corporate Event")
            summary = item.get("analysis", {}).get("summary_executive") or item.get("summary", "Key corporate update recorded.")
            key_dev_lines.append(f"*   **{title}**: {summary}")
        if not key_dev_lines:
            key_dev_lines.append("*   *Routine market intelligence signals monitored across counterparties.*")

        risk_lines = []
        for item in high_risk_items:
            title = item.get("title", "Risk Alert")
            summary = item.get("analysis", {}).get("summary_executive") or item.get("summary", "Elevated risk indicator detected.")
            risk_lines.append(f"*   **{title}**: {summary}")
        if not risk_lines:
            risk_lines.append("*   *No critical risk threshold breaches recorded in this run window.*")

        proc_lines = []
        for item in appointments:
            person = item.get("analysis", {}).get("person", "Executive")
            org = item.get("analysis", {}).get("organization", "Counterparty")
            proc_lines.append(f"*   **Key Appointment**: {person} logged under {org}.")
        for item in procurement:
            title = item.get("title", "Contract Award")
            proc_lines.append(f"*   **Procurement**: {title}")
        if not proc_lines:
            proc_lines.append("*   *No new public procurement or executive board changes logged in this window.*")

        md = f"""# PSC & Company Daily Intelligence Report
**Generated on:** {now.strftime('%Y-%m-%d %H:%M:%S')} (UTC+1)
**Run Window:** Daily Crawler Exec

## Summary Statistics
- **Total Articles Processed:** {total}
- **High Risk Signals:** {high_risk_count}
- **Appointments Logged:** {appointments_count}
- **Procurement Awards:** {procurement_count}

---

### Key Developments

{chr(10).join(key_dev_lines)}

### High Risk Alerts

{chr(10).join(risk_lines)}

### Procurement & Board Changes

{chr(10).join(proc_lines)}

---
*Report compiled by AURA Intelligence Scheduler (engine: rule-based).*"""

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

def make_node_id(text: str) -> str:
    """Returns a deterministic string ID for graph nodes."""
    import hashlib
    return hashlib.md5((text or "").strip().lower().encode("utf-8")).hexdigest()[:12]

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
    # Normalize empty string keys to "Content" for legacy report rows
    for r in reports:
        if "" in r:
            val = r.pop("")
            if not r.get("Content"):
                r["Content"] = val
    psc_records = db.get_significant_control()
    # Demo PSC rows are strictly opt-in (SEED_DEMO_PSC=true). By default an
    # empty Significant Control tab stays empty instead of being re-seeded
    # with placeholder billionaire disclosures.
    if not psc_records and settings.SEED_DEMO_PSC:
        default_psc_records = [
            { "Person Name": "Alhaji Aliko Dangote", "Company": "Dangote Cement Plc", "Nature of Control": "Direct ownership of >25% shares and voting rights", "Percentage": "85.8%", "Change Type": "Disclosed", "Date": "2026-01-15" },
            { "Person Name": "Abdul Samad Rabiu", "Company": "BUA Foods Plc", "Nature of Control": "Direct ownership of >25% shares & board appointments", "Percentage": "89.0%", "Change Type": "Disclosed", "Date": "2026-02-10" },
            { "Person Name": "Jubril Adewale Tinubu", "Company": "Oando Plc", "Nature of Control": "Indirect ownership via Ocean and Oil Development", "Percentage": "66.7%", "Change Type": "Increased Control", "Date": "2026-03-20" },
            { "Person Name": "Femi Otedola", "Company": "Geregu Power Plc", "Nature of Control": "Direct ownership of >25% voting shares", "Percentage": "78.6%", "Change Type": "Disclosed", "Date": "2026-04-12" },
            { "Person Name": "Jim Ovia", "Company": "Zenith Bank Plc", "Nature of Control": "Direct & indirect ownership of >15% voting rights", "Percentage": "16.2%", "Change Type": "Disclosed", "Date": "2026-05-01" },
            { "Person Name": "Tony O. Elumelu", "Company": "United Bank for Africa (UBA) Plc", "Nature of Control": "Indirect ownership via Heirs Holdings Limited", "Percentage": "24.5%", "Change Type": "Increased Control", "Date": "2026-06-18" },
            { "Person Name": "Aigboje Aig-Imoukhuede", "Company": "Access Holdings Plc", "Nature of Control": "Indirect ownership of voting rights & Non-Exec Chairman", "Percentage": "12.4%", "Change Type": "Appointed", "Date": "2026-03-14" }
        ]
        psc_records = default_psc_records
        for r in default_psc_records:
            try:
                db.add_significant_control(r)
            except Exception:
                pass

    # Sort chronological (newest first, excluding non-relevant filtered articles)
    articles_sorted = [a for a in reversed(articles) if a.get("Status") != "Filtered"][:60]
    
    # Save base files
    with open(os.path.join(DATA_DIR, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(articles_sorted, f, default=str, indent=2)
        
    with open(os.path.join(DATA_DIR, "companies.json"), "w", encoding="utf-8") as f:
        json.dump(companies, f, default=str, indent=2)
        
    with open(os.path.join(DATA_DIR, "people.json"), "w", encoding="utf-8") as f:
        json.dump(people, f, default=str, indent=2)
        
    with open(os.path.join(DATA_DIR, "procurement.json"), "w", encoding="utf-8") as f:
        json.dump(procurement, f, default=str, indent=2)

    with open(os.path.join(DATA_DIR, "significant_control.json"), "w", encoding="utf-8") as f:
        json.dump(psc_records, f, default=str, indent=2)
        
    with open(os.path.join(DATA_DIR, "reports.json"), "w", encoding="utf-8") as f:
        json.dump(reports, f, default=str, indent=2)

    # 3. Generate Knowledge Graph nodes and edges (Deterministic IDs)
    nodes = []
    edges = []
    node_keys = set()
    edge_keys = set()
    
    # Generate nodes from companies
    for row in companies[:20]:
        name = row.get("Company", "").strip()
        if name and name not in node_keys:
            node_keys.add(name)
            nodes.append({
                "id": make_node_id(name),
                "label": name,
                "type": "company",
                "risk": row.get("Risk Level", "Low")
            })
            
    # Generate nodes from agencies
    for row in agencies[:20]:
        name = row.get("Agency", "").strip()
        if name and name not in node_keys:
            node_keys.add(name)
            nodes.append({
                "id": make_node_id(name),
                "label": name,
                "type": "agency",
                "risk": "Low"
            })
            
    # Generate nodes and edges from People changes
    for row in people[:25]:
        person_name = row.get("Name", "").strip()
        org_name = row.get("Organization", "").strip()
        pos = row.get("Position", "Executive")
        
        if person_name:
            if person_name not in node_keys:
                node_keys.add(person_name)
                nodes.append({
                    "id": make_node_id(person_name),
                    "label": person_name,
                    "type": "person",
                    "risk": "Low"
                })
            
            # Connect Person to Organization
            if org_name:
                if org_name not in node_keys:
                    node_keys.add(org_name)
                    nodes.append({
                        "id": make_node_id(org_name),
                        "label": org_name,
                        "type": "company",
                        "risk": "Low"
                    })
                
                edge_key = f"{person_name}-{org_name}-works"
                if edge_key not in edge_keys:
                    edge_keys.add(edge_key)
                    edges.append({
                        "id": make_node_id(edge_key),
                        "from": make_node_id(person_name),
                        "to": make_node_id(org_name),
                        "label": f"Appointed as {pos}"
                    })

    # Generate nodes & edges from Persons with Significant Control (PSC)
    for row in psc_records[:20]:
        person_name = row.get("Person Name", "").strip()
        comp_name = row.get("Company", "").strip()
        ctrl = row.get("Nature of Control", "Significant Control")
        pct = row.get("Percentage", "")
        
        if person_name and comp_name:
            if person_name not in node_keys:
                node_keys.add(person_name)
                nodes.append({
                    "id": make_node_id(person_name),
                    "label": person_name,
                    "type": "psc",
                    "risk": "High"
                })
            if comp_name not in node_keys:
                node_keys.add(comp_name)
                nodes.append({
                    "id": make_node_id(comp_name),
                    "label": comp_name,
                    "type": "company",
                    "risk": "Medium"
                })
                
            edge_key = f"{person_name}-{comp_name}-psc"
            if edge_key not in edge_keys:
                edge_keys.add(edge_key)
                lbl = f"PSC: {pct}" if pct else ctrl
                edges.append({
                    "id": make_node_id(edge_key),
                    "from": make_node_id(person_name),
                    "to": make_node_id(comp_name),
                    "label": lbl
                })

    # Generate edges from Procurement
    for row in procurement[:20]:
        agency = row.get("Agency", "").strip()
        contractor = row.get("Contractor", "").strip()
        proj = row.get("Project", "Contract").strip()
        
        if agency and contractor:
            if agency not in node_keys:
                node_keys.add(agency)
                nodes.append({"id": make_node_id(agency), "label": agency, "type": "agency", "risk": "Low"})
            if contractor not in node_keys:
                node_keys.add(contractor)
                nodes.append({"id": make_node_id(contractor), "label": contractor, "type": "company", "risk": "Low"})
                
            edge_key = f"{contractor}-{agency}-contract"
            if edge_key not in edge_keys:
                edge_keys.add(edge_key)
                edges.append({
                    "id": make_node_id(edge_key),
                    "from": make_node_id(contractor),
                    "to": make_node_id(agency),
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
