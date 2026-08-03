import os
import sys
import json
import logging
import argparse
from datetime import datetime, timedelta
from typing import List, Dict, Any

# Adjust sys.path to find backend module
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# Configure logging BEFORE importing anything that logs at import time.
# backend.app.db.excel_db constructs SheetsDatabase() at module level, so its
# connection status, schema migrations and any errors are emitted during the
# import below. Configuring afterwards silently discarded all of it — a failed
# sheet migration looked identical to a successful one.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger("run_pipeline")

from backend.app.core.config import settings
from backend.app.services.ingestion import NewsIngestionService
from backend.app.services.llm import LLMService, LLMCascadeError
from backend.app.services import relevance
from backend.app.db.excel_db import db

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend", "app", "static", "data")

# Abort the run after this many articles in a row fail the whole LLM cascade:
# at that point the providers are down and continuing would only burn quota.
MAX_CONSECUTIVE_LLM_FAILURES = 3

# Publications are the source of an article, not participants in it. Models
# still surface them as organizations often enough to pollute the knowledge
# graph, so they are dropped defensively as well as discouraged in the prompt.
NEWS_OUTLET_MARKERS = (
    "guardian", "premium times", "punch", "vanguard", "daily post", "dailypost",
    "thisday", "this day", "nairametrics", "channels tv", "channels television",
    "leadership newspaper", "the nation", "businessday", "business day", "tribune",
    "sahara reporters", "peoples gazette", "the cable", "thecable", "legit.ng",
    "reuters", "bloomberg", "associated press", "al jazeera", "bbc", "cnn",
)

# Navigation furniture scraped from article pages.
NON_ENTITY_TERMS = {
    "archives", "archive", "home", "newsletter", "advertisement", "sponsored",
    "read more", "subscribe", "latest news", "breaking news", "news",
}


def is_publication_or_furniture(name: str) -> bool:
    """True when an extracted organization is really the publication or page chrome."""
    cleaned = " ".join((name or "").replace("\xa0", " ").split()).lower()
    if not cleaned or cleaned in NON_ENTITY_TERMS:
        return True
    return any(marker in cleaned for marker in NEWS_OUTLET_MARKERS)


# Nigerian PSC disclosure bands.
#
# CAMA 2020 s.868, read with the CAC Persons with Significant Control
# Regulations 2022, sets the Nigerian threshold at **5%** of shares or voting
# rights -- not the 25% used by the UK PSC register and the FATF standard.
# A 6% holder is a statutory PSC in Nigeria and invisible to a UK-calibrated
# tool, so the 5-25% band is tracked as a first-class category.
SHARE_BANDS = (
    (75.0, "BAND_75_100"),
    (50.0, "BAND_50_75"),
    (25.0, "BAND_25_50"),
    (5.0, "BAND_5_25"),
)


def share_band(percentage: Any) -> str:
    """Map a percentage (number, or a string like '28.5%') onto a CAMA band.

    Returns "" when no figure was disclosed, so the UI can say "not disclosed"
    rather than implying a band that was never reported.
    """
    if percentage is None:
        return ""
    try:
        value = float(str(percentage).replace("%", "").strip())
    except (TypeError, ValueError):
        return ""
    for floor, name in SHARE_BANDS:
        if value >= floor:
            return name
    return "BELOW_THRESHOLD"


# Illustrative PSC rows used only when SEED_DEMO_PSC=true.
# Every entity here is invented. Each row carries Source="seed" so the
# dashboard can label it as illustrative rather than extracted.
DEMO_PSC_RECORDS: List[Dict[str, Any]] = [
    { "Person Name": "Adaeze N. Okonkwo", "Company": "Harmattan Energy Plc", "Nature of Control": "Ownership of shares (75% to 100%)", "Percentage": "81.4%", "Direct %": "22.9%", "Indirect %": "58.5%", "Voting Rights %": "81.4%", "Share Band": "BAND_75_100", "Intermediate Entities": "Harmattan Industries Limited", "Board Role": "Founder & Group President", "PEP Status": "No", "Risk Level": "Elevated Control", "Regulatory Filing Ref": "CAC/PSC/2026/0891-HRM", "Verification Status": "Filed with CAC", "Change Type": "Disclosed", "Previous Holder": "", "Date": "2026-01-15", "Source": "seed", "Notes": "Controls the operating company through a single intermediate holding vehicle." },
    { "Person Name": "Bashir Umar-Sadiq", "Company": "Kaduna Agro Holdings Plc", "Nature of Control": "Ownership of shares (50% to 75%) and right to appoint a majority of directors", "Percentage": "63.2%", "Direct %": "11.0%", "Indirect %": "52.2%", "Voting Rights %": "88.0%", "Share Band": "BAND_50_75", "Intermediate Entities": "Meridian Trust (Mauritius) Limited", "Board Role": "Executive Chairman", "PEP Status": "No", "Risk Level": "Critical Risk", "Regulatory Filing Ref": "CAC/PSC/2026/0442-KAH", "Verification Status": "Filed with CAC", "Change Type": "Increased Control", "Previous Holder": "Sahel Nominees Limited", "Date": "2026-02-10", "Source": "seed", "Notes": "Voting rights materially exceed the equity stake, and control routes through an offshore vehicle." },
    { "Person Name": "Chinelo Adaora Eze", "Company": "Lekki Terminal Logistics Plc", "Nature of Control": "Exercises significant influence or control", "Percentage": "6.8%", "Direct %": "6.8%", "Indirect %": "0.0%", "Voting Rights %": "6.8%", "Share Band": "BAND_5_25", "Intermediate Entities": "Direct Holding", "Board Role": "Non-Executive Director", "PEP Status": "Yes - Politically exposed person", "Risk Level": "Elevated Control", "Regulatory Filing Ref": "CAC/PSC/2026/1029-LTL", "Verification Status": "Filed with CAC", "Change Type": "Disclosed", "Previous Holder": "", "Date": "2026-03-20", "Source": "seed", "Notes": "Below the 25% FATF threshold but a statutory PSC under CAMA 2020 s.868, which sets the Nigerian threshold at 5%." },
    { "Person Name": "Tunde Balogun", "Company": "Sahel Microfinance Bank Plc", "Nature of Control": "Ownership of shares (5% to 25%)", "Percentage": "4.7%", "Direct %": "4.7%", "Indirect %": "0.0%", "Voting Rights %": "4.7%", "Share Band": "BELOW_THRESHOLD", "Intermediate Entities": "Direct Holding", "Board Role": "Shareholder", "PEP Status": "No", "Risk Level": "Standard Disclosure", "Regulatory Filing Ref": "", "Verification Status": "Self-reported", "Change Type": "Disclosed", "Previous Holder": "", "Date": "2026-05-01", "Source": "seed", "Notes": "One of several holdings parked just below the 5% disclosure threshold." },
    { "Person Name": "Halima Yusuf-Bello", "Company": "Sahel Microfinance Bank Plc", "Nature of Control": "Ownership of shares (5% to 25%)", "Percentage": "4.9%", "Direct %": "4.9%", "Indirect %": "0.0%", "Voting Rights %": "4.9%", "Share Band": "BELOW_THRESHOLD", "Intermediate Entities": "Direct Holding", "Board Role": "Shareholder", "PEP Status": "No", "Risk Level": "Standard Disclosure", "Regulatory Filing Ref": "", "Verification Status": "Self-reported", "Change Type": "Disclosed", "Previous Holder": "", "Date": "2026-05-01", "Source": "seed", "Notes": "Second sub-threshold holding in the same company; see the sub-threshold structuring rule." },
    { "Person Name": "Adaeze N. Okonkwo", "Company": "Lekki Terminal Logistics Plc", "Nature of Control": "Ownership of shares (25% to 50%)", "Percentage": "28.5%", "Direct %": "4.0%", "Indirect %": "24.5%", "Voting Rights %": "28.5%", "Share Band": "BAND_25_50", "Intermediate Entities": "Harmattan Industries Limited", "Board Role": "Non-Executive Director", "PEP Status": "No", "Risk Level": "Elevated Control", "Regulatory Filing Ref": "CAC/PSC/2026/0554-LTL", "Verification Status": "Filed with CAC", "Change Type": "Increased Control", "Previous Holder": "Zamfara Nominees Limited", "Date": "2026-06-18", "Source": "seed", "Notes": "Second disclosed holding for the same person, giving a cross-entity portfolio." }
]


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

        # Relevance filter check (strictly keep corporate, policy, and procurement news).
        #
        # Two changes from the original single-boolean check:
        #
        # 1. The default is now False. `analysis.get("relevant", True)` meant a
        #    response missing the key was published — a filter that fails open.
        # 2. A deterministic topic guard runs behind the model. The model is
        #    told to reject sport and celebrity stories and mostly does, but
        #    when it does not, the result is a football transfer published at
        #    risk 40 under category "Company". The guard overrides it.
        off_topic = relevance.off_topic_reason(title, analysis.get("summary_executive"))
        if not analysis.get("relevant", False) or off_topic:
            if off_topic:
                logger.info(
                    f"Topic guard rejected '{title}' as {off_topic.topic} "
                    f"(matched: {', '.join(off_topic.matched)})"
                )
            else:
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

            # Drop the reporting publication and page furniture
            if is_publication_or_furniture(name):
                logger.info(f"Skipping non-entity organization: '{name}'")
                continue

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
        #
        # `psc.get(key, default)` was wrong here: the extraction schema tells
        # the model to emit null for anything it cannot find, so the key is
        # present with a None value and the default never fires. That wrote
        # None into the sheet and let the dashboard fall back to inventing a
        # plausible-looking filing reference. `.get(key) or default` collapses
        # both the missing-key and explicit-null cases onto the default.
        for psc in analysis.get("significant_control", []):
            db.add_significant_control({
                "Person Name": psc.get("name") or "",
                "Company": psc.get("organization") or "",
                "Nature of Control": psc.get("nature_of_control") or "",
                "Board Role": psc.get("board_role") or "",
                "Percentage": psc.get("percentage") or "",
                "Direct %": psc.get("direct_percentage") or "",
                "Indirect %": psc.get("indirect_percentage") or "",
                "Voting Rights %": psc.get("voting_rights_percentage") or "",
                "Share Band": share_band(psc.get("percentage")),
                "Intermediate Entities": psc.get("intermediate_entities") or "Direct Holding",
                "PEP Status": psc.get("pep_status") or "Not assessed",
                "Risk Level": psc.get("risk_level") or "Standard",
                "Regulatory Filing Ref": psc.get("regulatory_filing_ref") or "",
                "Verification Status": "Extracted from news reporting",
                "Change Type": psc.get("change_type") or "disclosed",
                "Previous Holder": psc.get("previous_holder") or "",
                "Date": datetime.now().strftime("%Y-%m-%d"),
                # Distinguishes real extractions from seeded demo rows so the
                # dashboard can label them honestly.
                "Source": "extracted"
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
    
    # Save timestamped archive markdown file.
    #
    # The name carries the time, not just the date. The scheduler runs four
    # times a day and the old date-only name meant runs 2-4 silently
    # overwrote run 1, so all four archive rows for a given day resolved to
    # whichever report happened to be written last.
    archive_dir = os.path.join(DATA_DIR, "archives")
    os.makedirs(archive_dir, exist_ok=True)
    archive_name = f"report_{now.strftime('%Y%m%d_%H%M%S')}.md"
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
        # The exact archive filename, so a reader can resolve an edition to
        # its document instead of guessing from the date.
        "Archive File": archive_name,
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
    # with placeholder disclosures.
    #
    # Every seeded row carries Source="seed". The dashboard keys its
    # "illustrative data" banner off that field rather than off "is the list
    # empty", because a seeded list is non-empty and the old check therefore
    # never fired -- publishing sample records as though they were extracted
    # intelligence.
    #
    # The entities below are invented. An earlier version of this seed used
    # real named individuals with invented ownership percentages, invented CAC
    # filing references and, in one case, an invented PEP classification. That
    # is defamatory in a compliance product and must never come back: if you
    # need richer demo data, extend these fictional entities.
    if not psc_records and settings.SEED_DEMO_PSC:
        default_psc_records = DEMO_PSC_RECORDS
        psc_records = default_psc_records
        for r in default_psc_records:
            try:
                db.add_significant_control(r)
            except Exception:
                pass

    # Sort chronological (newest first, excluding non-relevant filtered articles)
    #
    # The topic guard is re-applied here, not just at ingestion, because the
    # database still holds records written before the LLM cascade was enforced
    # — every row with an empty Engine column. Those never passed any relevance
    # check, and among them were a football transfer, a match report and a
    # celebrity wedding, all carrying real risk scores. Filtering on export is
    # non-destructive: the rows stay in the sheet as the audit record, they
    # just stop being published as intelligence.
    published = []
    suppressed = []
    for a in reversed(articles):
        if a.get("Status") == "Filtered":
            continue
        reason = relevance.off_topic_reason(a.get("Title"), a.get("Summary"))
        if reason:
            suppressed.append((a.get("Title"), reason))
            continue
        published.append(a)
        if len(published) >= 60:
            break

    if suppressed:
        logger.warning(
            f"Topic guard suppressed {len(suppressed)} stored article(s) from the "
            "published feed (they remain in the database):"
        )
        for stored_title, reason in suppressed[:20]:
            logger.warning(f"  [{reason.topic}] {stored_title}")

    articles_sorted = published

    # Entities extracted from those same articles are filtered too. The company
    # table had accumulated "Premier League", "Serie A", "BBNaija" and
    # "FIFA World Cup" as tracked corporate entities, and they flowed into the
    # knowledge graph as company and agency nodes.
    companies = [c for c in companies if not relevance.is_off_topic(c.get("Company"))]
    agencies = [a for a in agencies if not relevance.is_off_topic(a.get("Agency"))]
    people = [
        p for p in people
        if not relevance.is_off_topic(p.get("Organization"))
        and not relevance.is_off_topic(p.get("Name"))
    ]

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
