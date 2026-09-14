import os
import sys
import json
import random
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
from backend.app.services.ingestion import NewsIngestionService, parse_feed_date
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
# The publication / page-furniture guard lives in services.relevance with the
# other deterministic guards, so it can be reused without importing this module
# and its LLM and spaCy dependencies. Re-exported here because callers and
# tests/test_entity_filter.py import it from run_pipeline.
from backend.app.services.relevance import (  # noqa: E402  (re-export)
    NEWS_OUTLET_MARKERS,
    NON_ENTITY_TERMS,
    is_publication_or_furniture,
)


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


EVAL_CORPUS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "evals", "corpus")
# One in this many analysed articles is kept as a candidate for labelling.
# Guarded: this runs at import time, so a malformed env var used to raise
# ValueError before anything (including the FastAPI app importing this
# module) could start.
try:
    EVAL_CAPTURE_RATE = int(os.environ.get("EVAL_CAPTURE_RATE", "10"))
except ValueError:
    EVAL_CAPTURE_RATE = 10

# Below this, a capture is an RSS blurb rather than an article: unusable as
# a labelling input (scripts/validate_gold.py enforces the same floor) and a
# train/serve mismatch against the full bodies the gold set is built from.
EVAL_MIN_ARTICLE_CHARS = 200


def capture_eval_input(title: str, article_text: str, url: str, source: str) -> None:
    """
    Append a sampled extractor input to the eval corpus.

    Best-effort by design: this exists to make a gold set buildable, and losing
    a sample matters far less than failing an ingestion run over it. Any error
    is logged and swallowed.
    """
    if EVAL_CAPTURE_RATE <= 0:
        return
    try:
        # Blurbs are not labellable articles: two months of live capture
        # produced 245 records of which 82% were under the validator's
        # 200-char floor, and every gold example so far had to come from
        # the separately re-fetched backfill instead.
        if len((article_text or "").strip()) < EVAL_MIN_ARTICLE_CHARS:
            return
        if random.randint(1, EVAL_CAPTURE_RATE) != 1:
            return
        os.makedirs(EVAL_CORPUS_DIR, exist_ok=True)
        path = os.path.join(EVAL_CORPUS_DIR, f"{datetime.now().strftime('%Y%m')}.jsonl")
        # One capture per URL per month file; per-candidate sampling had no
        # memory and banked the same story twice.
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        if json.loads(line).get("url") == url:
                            return
                    except Exception:
                        continue
        record = {
            "title": title,
            "article_text": article_text,
            "url": url,
            "source": source,
            "captured_at": datetime.now().isoformat(timespec="seconds"),
        }
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("Could not capture eval input for '%s': %s", title, exc)


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
    run_started = datetime.now()
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
    
    # Fetch existing articles once to avoid Google Sheets 429 quota exhaustion.
    # A failed read now ABORTS the run instead of proceeding with an empty
    # URL set: continuing meant every candidate looked new, the whole batch
    # re-spent its LLM quota, and duplicate rows landed with colliding IDs.
    # _read_sheet retries with backoff before this raise ever reaches us.
    try:
        existing_articles = db.get_articles()
        existing_urls = {row.get("URL") for row in existing_articles if row.get("URL")}
    except Exception as e:
        logger.error(
            f"Could not read the Articles sheet after retries ({e}); aborting the run "
            "rather than re-analyzing the whole batch as if the database were empty."
        )
        raise

    # Articles published by earlier runs today, reduced to what the sheet
    # retains. The brief compiles over these plus this run's records, so the
    # front page carries the day's intelligence rather than being overwritten
    # by whichever run happened to go last -- the 23:00 run used to replace a
    # rich morning edition with a one-article stub. Snapshot is pre-loop, so
    # nothing added this run is double-counted.
    prior_today = published_today(existing_articles)
        
    # --- REDUNDANCY BUFFER ---
    new_candidates = [item for item in candidates if item.get("url") not in existing_urls]
    if not new_candidates:
        if not candidates:
            # Nothing was fetched at all -- this is an outage, not a quiet
            # day. collect_all() already logged why at WARNING; this is about
            # what the durable Daily Reports record says happened. Since
            # production padding became opt-in, a total fetcher outage lands
            # here instead of being masked by 25 synthetic articles, so this
            # branch must not describe it as "no significant change".
            logger.warning("No candidate articles were fetched this cycle -- recording it as an outage.")
            generated_message = "No articles were fetched this cycle. Check the source adapters and API keys."
        else:
            logger.info("Redundancy Buffer: No new articles found. Skipping LLM execution to save quota.")
            generated_message = "No significant change. Script was run at this specific time."
        db._append_row("Daily Reports", {
            # Date-only, like the normal report path writes -- routes.py
            # matches this column by exact string, and day_totals() keys on
            # it. The run's time lives in the Generated text.
            "Date": datetime.now().strftime("%Y-%m-%d"),
            "Total Articles": 0,
            "High Risk": 0,
            "Appointments": 0,
            "Procurement": 0,
            "Cascade Failures": 0,
            "Run Seconds": round((datetime.now() - run_started).total_seconds()),
            "Generated": f"{generated_message} ({datetime.now().strftime('%Y-%m-%d %H:%M:%S')})"
        })
        # A quiet cycle still refreshes the exports: weather, trends, tech
        # news, the feed and changes.json do not depend on new articles,
        # and returning before this left the dashboard showing yesterday's
        # weather and a stale "what changed this cycle" diff as current.
        try:
            export_static_json_database()
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(f"Quiet-cycle export failed: {exc}")
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
        # "summary" is the key every producer in the cascade actually sets;
        # "summary_executive" was never set by anything, so the guard was
        # silently matching against the title alone.
        off_topic = relevance.off_topic_reason(title, analysis.get("summary"))
        if not analysis.get("relevant", False) or off_topic:
            if off_topic:
                logger.info(
                    f"Topic guard rejected '{title}' as {off_topic.topic} "
                    f"(matched: {', '.join(off_topic.matched)})"
                )
            else:
                logger.info(f"Skipping non-relevant news item and logging URL to prevention cache: '{title}'")
            filtered_saved = db.add_article({
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
            # Only cache the URL when the prevention row actually persisted,
            # so a failed write is retried instead of silently skipped.
            if filtered_saved:
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

        # Keep a sample of the extractor's *inputs*. Everything written to the
        # sheet is model output -- Title, Summary, Category -- so there was no
        # way to build a labelled set from the archive: the article body, which
        # is the input the extractor is judged on, was discarded after analysis.
        # Sampled rather than exhaustive because this is committed to the repo.
        # Sampled here, after the relevance and topic gates, so sport and
        # celebrity rejects stop entering the gold-set candidate pool.
        capture_eval_input(title, cleaned_text, url, source)

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
        compile_daily_report(
            run_records, prior_today,
            cascade_failures=cascade_failures,
            run_seconds=round((datetime.now() - run_started).total_seconds()),
        )

    # 4. Dump Telemetry Database JSON dumps for Frontend Web Pages
    export_static_json_database()

    # 5. Optional high-risk webhook: gated on the ALERT_WEBHOOK_URL secret
    # and strictly best-effort -- an alerting side channel must never fail
    # the pipeline it reports on. Only this run's records are considered,
    # so a standing high-risk story does not re-alert every cycle.
    if new_articles_count > 0:
        try:
            from backend.app.services.feeds import high_risk_alerts, post_alert_webhook
            post_alert_webhook(os.environ.get("ALERT_WEBHOOK_URL", ""),
                               high_risk_alerts(run_records))
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(f"Alert webhook skipped: {exc}")

    # Partial cascade failures no longer fail the run red. Doing so made the
    # workflow skip its commit and deploy steps, so ONE transient 429 out of
    # forty articles threw away every export just written, left the site on
    # yesterday's data, and discarded the eval captures -- while the LLM
    # quota and the Sheets rows were already spent. Visibility is preserved
    # elsewhere: the Cascade Failures column on the Daily Reports row and the
    # dashboard's pipeline-health chart both carry the count, and a TOTAL
    # cascade outage (nothing published at all) still raises above.
    if cascade_failures > 0:
        logger.warning(
            f"{cascade_failures} article(s) failed the LLM provider cascade this run "
            f"({new_articles_count} succeeded). Publishing the successes; the failure "
            "count is recorded on the Daily Reports row and the health panel."
        )

    return {"status": "success", "processed": new_articles_count,
            "cascade_failures": cascade_failures}

def published_today(article_rows: List[Dict[str, Any]], today=None) -> List[Dict[str, Any]]:
    """Reduce today's already-published Articles rows to report-record shape.

    The sheet keeps Title/Source/URL/Category/Risk Score/Summary but not the
    full analysis, so these records carry what a brief needs and nothing that
    would have to be invented. The Time cell arrives in three formats (RFC
    2822, ISO with Z, plain ISO); parse_feed_date already reads all of them.
    """
    today = today or datetime.now().date()
    reduced = []
    for row in article_rows or []:
        # Rejects are written to the same sheet with Status "Filtered";
        # the export path already skips them, but this path fed them back
        # into the day's brief -- and at the observed ~80% reject rate,
        # most of the "coverage" handed to the report model was junk the
        # relevance guard had already thrown out.
        if str(row.get("Status", "")).strip().lower() == "filtered":
            continue
        stamp = parse_feed_date(row.get("Time"))
        if stamp is None or stamp.date() != today:
            continue
        try:
            score = float(str(row.get("Risk Score", "")).strip() or 0)
        except (TypeError, ValueError):
            score = 0.0
        reduced.append({
            "title": row.get("Title"),
            "source": row.get("Source"),
            "url": row.get("URL"),
            "analysis": {
                "summary": row.get("Summary") or "",
                "category": row.get("Category") or "",
                "risk_score": score,
                # The sheet keeps only the numeric score; >=70 mirrors the
                # dashboard's own critical-alert threshold (app.js).
                "risk_level": "High" if score >= 70 else "Standard",
            },
        })
    return reduced


def _int_cell(value: Any) -> int:
    """Sheet cells come back as int, float, or string; NaN/blank count as 0."""
    try:
        return int(float(str(value).strip() or 0))
    except (TypeError, ValueError):
        return 0


def day_totals(report_rows: List[Dict[str, Any]], today_str: str) -> Dict[str, int]:
    """Sum today's earlier per-run Daily Reports rows.

    Each run writes a per-run row (that stays per-run -- it is the time
    series), so the exact day-to-date totals are the sum of today's rows
    plus the current run. Date is compared on its first 10 chars because a
    historical branch wrote full timestamps into the Date column.
    """
    totals = {"Total Articles": 0, "High Risk": 0, "Appointments": 0, "Procurement": 0}
    for row in report_rows or []:
        if str(row.get("Date", "")).strip()[:10] != today_str:
            continue
        for key in totals:
            totals[key] += _int_cell(row.get(key))
    return totals


def report_payload(records: List[Dict[str, Any]], summary_limit: int = 400) -> List[Dict[str, Any]]:
    """Shape records for the report prompt, truncating long summaries.

    A 60-article day would otherwise serialize every full summary into the
    prompt; past ~400 chars a summary stops adding signal and starts
    crowding out other articles' context.
    """
    payload = []
    for r in records or []:
        analysis = dict(r.get("analysis") or {})
        summary = analysis.get("summary")
        if isinstance(summary, str) and len(summary) > summary_limit:
            analysis["summary"] = summary[:summary_limit].rstrip() + "..."
        payload.append({
            "title": r.get("title"),
            "source": r.get("source"),
            "url": r.get("url"),
            "analysis": analysis,
        })
    return payload


def _loose_number(value):
    """Loose numeric parse for sheet cells: '12.5%', '12,5', 40 -> float, else None."""
    s = str(value if value is not None else "").strip().replace("%", "").replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def compute_cycle_changes(prev: Dict[str, Any], curr: Dict[str, Any]) -> Dict[str, Any]:
    """Pure diff between the previous static-JSON snapshot and this run's.

    `prev`/`curr` carry the exported row lists under "articles", "companies",
    "people" and "psc"; missing keys and a missing prev (first run, an old
    deploy) mean empty. Entities key on their name columns, PSC rows on
    (Person Name, Company), articles on URL. Everything returned is sorted
    so the payload is deterministic for a given pair of snapshots.
    """
    prev = prev or {}
    curr = curr or {}

    def names(rows, key):
        return {str(r.get(key, "")).strip() for r in rows or [] if str(r.get(key, "")).strip()}

    new_companies = sorted(names(curr.get("companies"), "Company") - names(prev.get("companies"), "Company"))
    new_people = sorted(names(curr.get("people"), "Name") - names(prev.get("people"), "Name"))

    def psc_key(row):
        return (str(row.get("Person Name", "")).strip().lower(),
                str(row.get("Company", "")).strip().lower())

    def psc_entry(row):
        return {"person": str(row.get("Person Name", "")).strip(),
                "company": str(row.get("Company", "")).strip()}

    prev_psc = {psc_key(r): r for r in prev.get("psc") or [] if any(psc_key(r))}
    curr_psc = {psc_key(r): r for r in curr.get("psc") or [] if any(psc_key(r))}

    psc_added = [psc_entry(r) for k, r in sorted(curr_psc.items()) if k not in prev_psc]
    psc_removed = [psc_entry(r) for k, r in sorted(prev_psc.items()) if k not in curr_psc]
    psc_changed = []
    for k, r in sorted(curr_psc.items()):
        if k not in prev_psc:
            continue
        before = _loose_number(prev_psc[k].get("Percentage"))
        after = _loose_number(r.get("Percentage"))
        if before is not None and after is not None and abs(before - after) > 1e-9:
            entry = psc_entry(r)
            entry["from"] = before
            entry["to"] = after
            psc_changed.append(entry)

    prev_urls = {str(r.get("URL", "")) for r in prev.get("articles") or [] if r.get("URL")}
    new_high_risk = []
    for r in curr.get("articles") or []:
        url = str(r.get("URL", ""))
        if url and url in prev_urls:
            continue
        score = _loose_number(r.get("Risk Score"))
        # 70 mirrors the dashboard's alert threshold (app.js).
        if score is not None and score >= 70:
            new_high_risk.append({"title": str(r.get("Title", "")), "url": url, "risk": score})
    new_high_risk.sort(key=lambda e: (-e["risk"], e["title"]))

    return {
        "new_companies": new_companies,
        "new_people": new_people,
        "psc_added": psc_added,
        "psc_removed": psc_removed,
        "psc_changed": psc_changed,
        "new_high_risk": new_high_risk,
        "counts": {
            "new_companies": len(new_companies),
            "new_people": len(new_people),
            "psc_added": len(psc_added),
            "psc_removed": len(psc_removed),
            "psc_changed": len(psc_changed),
            "new_high_risk": len(new_high_risk),
        },
    }


def compile_daily_report(records: List[Dict[str, Any]], prior_today: List[Dict[str, Any]] = None,
                         cascade_failures: int = 0, run_seconds: int = None):
    """Compiles statistics and writes the daily intelligence summary markdown.

    `records` is this run's fully-analysed output; `prior_today` is the
    reduced form of articles earlier runs published today. The markdown brief
    and its headline statistics cover the whole day; the Daily Reports row
    written at the end stays strictly per-run, because day totals are
    computed by summing those rows. `cascade_failures` and `run_seconds`
    are persisted on that row as the pipeline-health time series.
    """
    now = datetime.now()
    prior_today = prior_today or []

    total = len(records)
    high_risk_count = sum(1 for r in records if r["analysis"].get("risk_level") in ["High", "Critical"])
    appointments_count = sum(1 for r in records if r["analysis"].get("event_type") == "Appointment")
    procurement_count = sum(1 for r in records if r["analysis"].get("event_type") == "Procurement" or r["analysis"].get("procurement"))

    # Day-to-date = today's earlier per-run rows + this run.
    try:
        earlier_rows = db.get_daily_reports()
    except Exception as exc:
        logger.error(f"Could not read earlier Daily Reports rows for day totals: {exc}")
        earlier_rows = []
    today_str = now.strftime("%Y-%m-%d")
    day = day_totals(earlier_rows, today_str)
    runs_today = 1 + sum(1 for row in earlier_rows if str(row.get("Date", "")).strip()[:10] == today_str)
    day_total = day["Total Articles"] + total
    day_high = day["High Risk"] + high_risk_count
    day_appointments = day["Appointments"] + appointments_count
    day_procurement = day["Procurement"] + procurement_count

    logger.info("Calling LLM API (Gemini -> NVIDIA -> Ollama -> OpenAI) to compile rich markdown summary report...")
    # The model sees the whole day -- this run's full analyses plus the
    # reduced records of what earlier runs already published -- wrapped with
    # the date and coverage window the prompt declares authoritative.
    day_records = records + prior_today
    raw_json_str = json.dumps({
        "report_date": today_str,
        "coverage": f"All articles published on {today_str} up to {now.strftime('%H:%M')} (run {runs_today} of the day)",
        "articles": report_payload(day_records),
    }, default=str)

    try:
        generated_md, report_engine = LLMService.generate_daily_report(raw_json_str)
    except LLMCascadeError:
        if not settings.ALLOW_HEURISTIC_FALLBACK:
            # Fail red: no templated junk report is written or published.
            raise
        logger.warning("All report providers failed. ALLOW_HEURISTIC_FALLBACK is on; writing deterministic rule-based report.")
        generated_md, report_engine = "", "rule-based"

    # The header reports the day, not the run: this file is the site's front
    # page, and per-run numbers made the last run of the day (often the
    # smallest) look like the whole day's coverage.
    header = f"""# PSC & Company Daily Intelligence Report
**Generated on:** {now.strftime('%Y-%m-%d %H:%M:%S')} (UTC+1)
**Run Window:** {today_str}, all runs to {now.strftime('%H:%M')} (run {runs_today} of the day)

## Summary Statistics
- **Total Articles Processed:** {day_total}
- **High Risk Signals:** {day_high}
- **Appointments Logged:** {day_appointments}
- **Procurement Awards:** {day_procurement}

---
"""

    if generated_md:
        md = f"""{header}
{generated_md}

---
*Report compiled cloud-based by AURA Intelligence Scheduler (engine: {report_engine}).*"""
    else:
        # Fallback to deterministic rule-based executive summary report if Gemini API is offline/rate-limited
        high_risk_items = [r for r in day_records if r.get("analysis", {}).get("risk_level") in ["High", "Critical"]]
        key_items = [r for r in day_records if r.get("analysis", {}).get("risk_level") not in ["High", "Critical"]][:8]
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

        md = f"""{header}
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

    # Retention: keep the newest 180 editions (~45 days at 4 runs/day).
    # Nothing pruned these; the directory was 167 files and climbing four a
    # day, all committed to the repo on every run. Filenames sort
    # chronologically (report_YYYYMMDD[_HHMMSS].md), and the auto-commit
    # step picks up deletions under its file pattern.
    try:
        editions = sorted(f for f in os.listdir(archive_dir)
                          if f.startswith("report_") and f.endswith(".md"))
        for stale in editions[:-180]:
            os.remove(os.path.join(archive_dir, stale))
        if len(editions) > 180:
            logger.info(f"Archive retention removed {len(editions) - 180} edition(s) older than the newest 180.")
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(f"Archive retention sweep failed: {exc}")

    db.add_daily_report({
        "Date": now.strftime("%Y-%m-%d"),
        "Total Articles": total,
        "High Risk": high_risk_count,
        "Appointments": appointments_count,
        "Procurement": procurement_count,
        "Cascade Failures": cascade_failures,
        "Run Seconds": "" if run_seconds is None else run_seconds,
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


def slim_report_rows(reports: List[Dict[str, Any]], keep: int = 120) -> List[Dict[str, Any]]:
    """Rows for reports.json: the newest `keep`, inline markdown stripped
    where the identical bytes already exist as an archive file.

    The exported file had grown to ~570KB of which 90% was the Content
    column -- fetched on every dashboard load, growing ~3.4MB/year, while
    data/archives/ holds the same markdown per edition. Legacy rows that
    predate the Archive File column keep their inline Content, since it is
    the only copy.
    """
    out = []
    for row in (reports or [])[-keep:]:
        r = dict(row)
        if str(r.get("Archive File", "")).strip():
            r["Content"] = ""
        out.append(r)
    return out


def dedupe_entity_rows(rows: List[Dict[str, Any]], key_fields: List[str],
                       count_key: str = None) -> List[Dict[str, Any]]:
    """Case-insensitive dedupe of exported entity rows.

    The Companies sheet holds e.g. eight copies of one outlet and People
    734 rows for 627 distinct (name, organization) pairs -- legacy rows
    written before add_company's find-or-update existed. First occurrence
    keeps its position; when `count_key` is given the highest count wins,
    otherwise the latest duplicate (the freshest row) does.
    """
    best: Dict[Any, Dict[str, Any]] = {}
    order: List[Any] = []
    for row in rows or []:
        key = tuple(str(row.get(f, "")).strip().lower() for f in key_fields)
        if not any(key):
            continue
        if key not in best:
            best[key] = row
            order.append(key)
        elif count_key:
            if _int_cell(row.get(count_key)) > _int_cell(best[key].get(count_key)):
                best[key] = row
        else:
            best[key] = row
    return [best[k] for k in order]


def top_rows(rows: List[Dict[str, Any]], n: int, count_key: str = None,
             date_key: str = None) -> List[Dict[str, Any]]:
    """The N rows most worth graphing, instead of the first N inserted.

    The graph slices used to take `companies[:20]` etc. over sheets in
    insertion order -- a fixed window onto the oldest records. Sorts by
    mention count (when given) then date string (ISO-ish, so lexical works),
    both descending; stable, so ties keep sheet order.
    """
    def sort_key(row):
        count = _int_cell(row.get(count_key)) if count_key else 0
        date = str(row.get(date_key, "")) if date_key else ""
        return (count, date)
    return sorted(rows or [], key=sort_key, reverse=True)[:n]

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
    # is_publication_or_furniture runs here as well as at ingestion: the
    # ~1,100 legacy company rows written before that guard existed still
    # carry outlets ("The Guardian Nigeria News", literal "Archives" chrome)
    # and sailed into companies.json and the graph as tracked entities.
    companies = [
        c for c in companies
        if not relevance.is_off_topic(c.get("Company"))
        and not is_publication_or_furniture(c.get("Company"))
    ]
    agencies = [
        a for a in agencies
        if not relevance.is_off_topic(a.get("Agency"))
        and not is_publication_or_furniture(a.get("Agency"))
    ]
    people = [
        p for p in people
        if not relevance.is_off_topic(p.get("Organization"))
        and not relevance.is_off_topic(p.get("Name"))
        and not is_publication_or_furniture(p.get("Organization"))
    ]
    # Procurement and PSC rows feed the same graph and their own exports,
    # and were never filtered at all.
    procurement = [
        row for row in procurement
        if not relevance.is_off_topic(row.get("Agency"))
        and not relevance.is_off_topic(row.get("Contractor"))
        and not is_publication_or_furniture(row.get("Contractor"))
    ]
    psc_records = [
        row for row in psc_records
        if not is_publication_or_furniture(row.get("Company"))
        and not is_publication_or_furniture(row.get("Person Name"))
    ]

    # Legacy duplicate rows collapse at export (the sheet keeps its audit
    # trail): one row per company, one per (person, organization).
    companies = dedupe_entity_rows(companies, ["Company"], count_key="Mention Count")
    people = dedupe_entity_rows(people, ["Name", "Organization"])

    # "What changed this cycle": diff against the snapshots the previous run
    # left on disk, before they are overwritten below. A missing or
    # unreadable file (first run, fresh checkout) diffs as empty, so the
    # first changes.json simply reports everything as new.
    def _prev_snapshot(name):
        try:
            with open(os.path.join(DATA_DIR, name), encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []

    changes = compute_cycle_changes(
        {
            "articles": _prev_snapshot("latest.json"),
            "companies": _prev_snapshot("companies.json"),
            "people": _prev_snapshot("people.json"),
            "psc": _prev_snapshot("significant_control.json"),
        },
        {
            "articles": articles_sorted,
            "companies": companies,
            "people": people,
            "psc": psc_records,
        },
    )
    changes["generated"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(os.path.join(DATA_DIR, "changes.json"), "w", encoding="utf-8") as f:
        json.dump(changes, f, default=str, indent=2)

    # Context signals: weather for the two home ports and term/category
    # momentum over our own articles (plus a best-effort r/Nigeria social
    # column). Fetched pipeline-side because the site's CSP pins
    # connect-src to 'self'. Strictly best-effort -- neither may ever fail
    # a news run, and a failed weather fetch keeps the previous file
    # rather than publishing an empty one.
    try:
        from backend.app.services.weather import fetch_weather
        weather = fetch_weather()
        if weather:
            with open(os.path.join(DATA_DIR, "weather.json"), "w", encoding="utf-8") as f:
                json.dump(weather, f, default=str, indent=2)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(f"Weather export skipped: {exc}")

    try:
        from backend.app.services.trends import compute_trends, fetch_reddit_nigeria
        trends = compute_trends(articles)
        trends["social"] = fetch_reddit_nigeria()
        trends["generated"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(os.path.join(DATA_DIR, "trends.json"), "w", encoding="utf-8") as f:
            json.dump(trends, f, default=str, indent=2)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(f"Trends export skipped: {exc}")

    # Tech & AI headlines: a keyless, LLM-free side vertical rendered in
    # its own panel. Best-effort, and an empty result keeps the previous
    # file rather than blanking the panel over one bad fetch window.
    try:
        from backend.app.services.tech_news import build_tech_news
        tech = build_tech_news()
        if tech.get("ai") or tech.get("dev"):
            with open(os.path.join(DATA_DIR, "tech_news.json"), "w", encoding="utf-8") as f:
                json.dump(tech, f, default=str, indent=2)
        else:
            logger.warning("Tech news export skipped: every feed came back empty.")
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(f"Tech news export skipped: {exc}")

    # Save base files
    with open(os.path.join(DATA_DIR, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(articles_sorted, f, default=str, indent=2)

    with open(os.path.join(DATA_DIR, "companies.json"), "w", encoding="utf-8") as f:
        json.dump(companies, f, default=str, indent=2)

    with open(os.path.join(DATA_DIR, "people.json"), "w", encoding="utf-8") as f:
        json.dump(people, f, default=str, indent=2)
        
    with open(os.path.join(DATA_DIR, "procurement.json"), "w", encoding="utf-8") as f:
        json.dump(procurement, f, default=str, indent=2)

    # Agencies were already fetched and filtered for the graph step but
    # never exported like companies/people -- the agency dossier pages
    # need them. Same data, already in memory; no new query.
    with open(os.path.join(DATA_DIR, "agencies.json"), "w", encoding="utf-8") as f:
        json.dump(agencies, f, default=str, indent=2)

    with open(os.path.join(DATA_DIR, "significant_control.json"), "w", encoding="utf-8") as f:
        json.dump(psc_records, f, default=str, indent=2)
        
    with open(os.path.join(DATA_DIR, "reports.json"), "w", encoding="utf-8") as f:
        json.dump(slim_report_rows(reports), f, default=str, indent=2)

    # RSS feed over the same editions -- static, like everything else
    # GitHub Pages serves. Best-effort: syndication must not fail a run.
    try:
        from backend.app.services.feeds import build_rss_feed
        with open(os.path.join(DATA_DIR, "feed.xml"), "w", encoding="utf-8") as f:
            f.write(build_rss_feed(reports))
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(f"RSS feed export skipped: {exc}")

    # 3. Generate Knowledge Graph nodes and edges (Deterministic IDs)
    nodes = []
    edges = []
    node_keys = set()
    edge_keys = set()
    
    # Slices are worth-ranked (see top_rows); [:20] over insertion order
    # was a fixed window onto the oldest sheet rows.
    for row in top_rows(companies, 20, count_key="Mention Count", date_key="Last Seen"):
        name = row.get("Company", "").strip()
        if name and make_node_id(name) not in node_keys:
            node_keys.add(make_node_id(name))
            nodes.append({
                "id": make_node_id(name),
                "label": name,
                "type": "company",
                "risk": row.get("Risk Level", "Low")
            })
            
    # Generate nodes from agencies
    for row in top_rows(agencies, 20, date_key="Date"):
        name = row.get("Agency", "").strip()
        if name and make_node_id(name) not in node_keys:
            node_keys.add(make_node_id(name))
            nodes.append({
                "id": make_node_id(name),
                "label": name,
                "type": "agency",
                "risk": "Low"
            })
            
    # Generate nodes and edges from People changes
    for row in top_rows(people, 25, date_key="Date"):
        person_name = row.get("Name", "").strip()
        org_name = row.get("Organization", "").strip()
        pos = row.get("Position", "Executive")
        
        if person_name:
            if make_node_id(person_name) not in node_keys:
                node_keys.add(make_node_id(person_name))
                nodes.append({
                    "id": make_node_id(person_name),
                    "label": person_name,
                    "type": "person",
                    "risk": "Low"
                })
            
            # Connect Person to Organization
            if org_name:
                if make_node_id(org_name) not in node_keys:
                    node_keys.add(make_node_id(org_name))
                    nodes.append({
                        "id": make_node_id(org_name),
                        "label": org_name,
                        "type": "company",
                        "risk": "Low"
                    })
                
                edge_key = f"{person_name}-{org_name}-works"
                if make_node_id(edge_key) not in edge_keys:
                    edge_keys.add(make_node_id(edge_key))
                    edges.append({
                        "id": make_node_id(edge_key),
                        "from": make_node_id(person_name),
                        "to": make_node_id(org_name),
                        "label": f"Appointed as {pos}"
                    })

    # Generate nodes & edges from Persons with Significant Control (PSC)
    for row in top_rows(psc_records, 20, date_key="Date"):
        person_name = row.get("Person Name", "").strip()
        comp_name = row.get("Company", "").strip()
        ctrl = row.get("Nature of Control", "Significant Control")
        pct = row.get("Percentage", "")
        
        if person_name and comp_name:
            if make_node_id(person_name) not in node_keys:
                node_keys.add(make_node_id(person_name))
                nodes.append({
                    "id": make_node_id(person_name),
                    "label": person_name,
                    "type": "psc",
                    "risk": "High"
                })
            if make_node_id(comp_name) not in node_keys:
                node_keys.add(make_node_id(comp_name))
                nodes.append({
                    "id": make_node_id(comp_name),
                    "label": comp_name,
                    "type": "company",
                    "risk": "Medium"
                })
                
            edge_key = f"{person_name}-{comp_name}-psc"
            if make_node_id(edge_key) not in edge_keys:
                edge_keys.add(make_node_id(edge_key))
                lbl = f"PSC: {pct}" if pct else ctrl
                edges.append({
                    "id": make_node_id(edge_key),
                    "from": make_node_id(person_name),
                    "to": make_node_id(comp_name),
                    "label": lbl
                })

    # Generate edges from Procurement
    # No date column on Procurement; rows append chronologically, so the
    # newest are at the end.
    for row in list(reversed(procurement))[:20]:
        agency = row.get("Agency", "").strip()
        contractor = row.get("Contractor", "").strip()
        proj = row.get("Project", "Contract").strip()
        
        if agency and contractor:
            if make_node_id(agency) not in node_keys:
                node_keys.add(make_node_id(agency))
                nodes.append({"id": make_node_id(agency), "label": agency, "type": "agency", "risk": "Low"})
            if make_node_id(contractor) not in node_keys:
                node_keys.add(make_node_id(contractor))
                nodes.append({"id": make_node_id(contractor), "label": contractor, "type": "company", "risk": "Low"})
                
            edge_key = f"{contractor}-{agency}-contract"
            if make_node_id(edge_key) not in edge_keys:
                edge_keys.add(make_node_id(edge_key))
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
