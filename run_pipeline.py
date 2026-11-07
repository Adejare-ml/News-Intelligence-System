import os
import sys
import json
import random
import logging
import argparse
from datetime import datetime, timedelta
from typing import List, Dict, Any
from urllib.parse import urlparse

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
from backend.app.services import analytics, images as article_images, relevance
from backend.app.services import register_quality
from backend.app.services import story_detail
from backend.app.services import claude_llm
from backend.app.services import email_digest
from backend.app.services import suppression
from backend.app.pipeline import side_feeds
from backend.app.db.excel_db import db

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend", "app", "static", "data")

# Lead images news APIs returned with this run's saved articles (article
# URL -> image URL), merged into data/article_images.json at export.
RUN_IMAGES: Dict[str, str] = {}

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
    PLACEHOLDER_PERSON_NAMES,
    is_placeholder_person,
    is_publication_or_furniture,
    is_role_or_org_name,
    is_unevidenced_officer,
)
# CAMA 2020 PSC disclosure bands: see backend/app/pipeline/bands.py.
from backend.app.pipeline.bands import SHARE_BANDS, share_band  # noqa: E402,F401  (re-export)



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
        # warning, not debug: this was the only .debug call in the pipeline
        # and the INFO-level config swallowed it, so a broken eval capture
        # was completely silent while the corpus quietly stopped growing.
        logger.warning("Could not capture eval input for '%s': %s", title, exc)


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
            "Generated": f"{generated_message} ({datetime.now().strftime('%Y-%m-%d %H:%M:%S')})",
            "Candidates": NewsIngestionService.last_collect_stats.get("fetched", ""),
            "Rejected": 0,
            "Undated": NewsIngestionService.last_collect_stats.get("undated", ""),
            "Stubs": NewsIngestionService.last_collect_stats.get("stubs", ""),
            "Nigerian": NewsIngestionService.last_collect_stats.get("nigerian", ""),
            "Fresh": NewsIngestionService.last_collect_stats.get("fresh", ""),
            "Distinct": NewsIngestionService.last_collect_stats.get("distinct", ""),
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
    rejected_count = 0

    for item in candidates:
        url = item.get("url")
        title = item.get("title")
        source = item.get("source")

        # Deduplication check
        if url in existing_urls:
            continue

        text = item.get("raw_text") or title

        # Clean text basic HTML strips
        from backend.app.services.nlp_pipeline import NLPPipelineService
        cleaned_text = NLPPipelineService.clean_html(text)

        # Deterministic topic guard BEFORE the model, title-only. The same
        # guard already ran after extraction as a backstop -- but by then
        # the LLM call, a Sheets row and a 3.5s rate-limit sleep were spent
        # on an article it was always going to reject, and measured
        # production data showed ~80% of analysed rows were rejects.
        # Title-only deliberately: a full body gives a title-grade guard
        # too much surface to false-match on (a sanctions story quoting a
        # football club sponsor is still a sanctions story). The post-LLM
        # check stays and additionally sees the model's summary.
        pre_off_topic = relevance.off_topic_reason(title)
        if pre_off_topic:
            logger.info(
                f"Topic guard rejected '{title}' pre-LLM as {pre_off_topic.topic} "
                f"(matched: {', '.join(pre_off_topic.matched)}) -- no extraction call spent."
            )
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
                "Engine": "pre-llm-guard",
                "Filter Reason": filter_reason(pre_off_topic)
            })
            if filtered_saved:
                existing_urls.add(url)
            rejected_count += 1
            # Sheets write pacing only -- no LLM call happened.
            import time
            time.sleep(1.0)
            continue

        logger.info(f"Analyzing: '{title}' ({source})")

        # Google News gives only the headline and a feed snippet. When Claude
        # is configured, look the outlet's own article up on the web (a few
        # per run), so extraction, key facts and the email read the full
        # report. The row keeps its Google News URL, which is what later
        # runs deduplicate on.
        if (urlparse(url or "").hostname or "").lower() == "news.google.com" \
                and story_detail.detail_level(cleaned_text, title, source) == "headline" \
                and claude_llm.configured():
            fetched = claude_llm.fetch_article(title, source, item.get("published_at") or "")
            if fetched:
                logger.info(f"Fetched the full article for '{title[:80]}' from {fetched['url']}")
                cleaned_text = fetched["text"]

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
                "Engine": analysis.get("engine", ""),
                "Filter Reason": filter_reason(off_topic) if off_topic else "model-irrelevant"
            })
            # Only cache the URL when the prevention row actually persisted,
            # so a failed write is retried instead of silently skipped.
            if filtered_saved:
                existing_urls.add(url)
            rejected_count += 1
            import time
            time.sleep(3.5)
            continue

        # Write Article to Database. Event Type, Risk Level, Importance and
        # Entities were all in `analysis` (extracted and paid for on every
        # article) and then thrown away here; persisting them is what lets
        # the dashboard facet the feed and join articles to entities
        # without substring-guessing.
        # Read from the full article now; the email shows them later. What
        # the grounding check dropped is dropped for the daily brief model
        # too, which reads `analysis` below.
        detail_cells = story_detail.article_cells(analysis, cleaned_text, title, source)
        analysis["key_facts"] = story_detail.clean_facts(detail_cells["Key Facts"])
        analysis["why_it_matters"] = detail_cells["Why It Matters"]
        db_article = {
            "ID": "", # Auto incremented inside ExcelDatabase
            "Time": item.get("published_at") or datetime.now().isoformat(),
            "Title": title,
            "Source": source,
            "URL": url,
            "Category": analysis.get("category", "Other"),
            "Risk Score": int(analysis.get("risk_score", 10)),
            "Summary": story_detail.clean_summary(analysis.get("summary")) or title,
            "Status": "Unread",
            "Engine": analysis.get("engine", ""),
            "Event Type": analysis.get("event_type") or "Other",
            "Risk Level": analysis.get("risk_level") or "",
            "Importance": _int_cell(analysis.get("importance_score", 50)),
            "Entities": entity_mentions(analysis),
            **detail_cells,
        }
        
        added = db.add_article(db_article)

        # Rate limiting lives in the single 4-second sleep at the bottom of
        # this loop. A second 3.5s sleep sat here for months claiming to be
        # the throttle too -- 7.5s per accepted article, ~3 wasted minutes
        # on a 40-article run, found in the 2026-10-10 audit.
        if not added:
            continue

        article_images.remember(RUN_IMAGES, url, item.get("image"))
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
                    # Extracted sector when the model saw one; "General" was
                    # hardcoded here, which made Industry a schema column
                    # that read "General" on 1009 of 1009 rows.
                    "Industry": org.get("industry") or "General",
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
                "Source": "extracted",
                # The reporting behind the claim, linked from every page
                # that shows it.
                "Source URL": url,
                "Source Title": title,
                "Publisher": source,
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
            rejected=rejected_count,
        )

    # 3.5 Persist this run's high-risk alerts to the durable ledger BEFORE
    # the export runs, so alerts.json carries them this cycle rather than
    # next. The webhook below fire-and-forgets the same payload; this is
    # the copy the dashboard's alert band gets history from. Best-effort:
    # the ledger must never fail the run it records.
    if new_articles_count > 0:
        try:
            from backend.app.services.feeds import high_risk_alerts
            entities_by_url = {r.get("url"): entity_mentions(r.get("analysis") or {})
                               for r in run_records}
            for alert in high_risk_alerts(run_records):
                db.add_alert({
                    "Date": datetime.now().strftime("%Y-%m-%d"),
                    "Title": alert["title"],
                    "URL": alert["url"],
                    "Source": alert["source"],
                    "Risk Score": int(alert["risk_score"]),
                    "Risk Level": alert["risk_level"],
                    "Entities": entities_by_url.get(alert["url"], ""),
                })
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(f"Alerts ledger write skipped: {exc}")

    # 4. Dump Telemetry Database JSON dumps for Frontend Web Pages
    export_static_json_database()

    # 5. Optional high-risk webhook: gated on the ALERT_WEBHOOK_URL secret
    # and strictly best-effort -- an alerting side channel must never fail
    # the pipeline it reports on. Only this run's records are considered,
    # so a standing high-risk story does not re-alert every cycle.
    if new_articles_count > 0:
        try:
            from backend.app.services.feeds import (
                high_risk_alerts, post_alert_webhook, post_ntfy_alerts)
            run_alerts = high_risk_alerts(run_records)
            post_alert_webhook(os.environ.get("ALERT_WEBHOOK_URL", ""), run_alerts)
            # Same best-effort contract, phone-native transport: one push
            # per record to a private ntfy.sh topic (see docs/NOTIFICATIONS.md).
            post_ntfy_alerts(os.environ.get("NTFY_TOPIC_URL", ""), run_alerts)
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

# Pure report helpers live in backend/app/pipeline/report.py; re-exported
# because callers and tests import them from run_pipeline.
from backend.app.pipeline.report import (  # noqa: E402,F401  (re-export)
    _int_cell,
    _loose_number,
    compute_cycle_changes,
    day_totals,
    entity_mentions,
    filter_reason,
    published_today,
    report_payload,
)

def compile_daily_report(records: List[Dict[str, Any]], prior_today: List[Dict[str, Any]] = None,
                         cascade_failures: int = 0, run_seconds: int = None,
                         rejected: int = None):
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
**Generated on:** {now.strftime('%Y-%m-%d %H:%M:%S')} (UTC)
**Run Window:** {today_str}, all runs to {now.strftime('%H:%M')} (run {runs_today} of the day)

## Summary Statistics
- **Total Articles Processed:** {day_total}
- **High Risk Signals:** {day_high}
- **Appointments Logged:** {day_appointments}
- **Procurement Awards:** {day_procurement}

---
"""

    if generated_md:
        # The model's headline is checked against its source article: one
        # naming someone the article never mentions is replaced by the
        # article's own title, and repeated bullets are dropped.
        generated_md = register_quality.qa_brief_headlines(generated_md, day_records)
        # Then by rule: every bullet cites an article, alerts are only High
        # or Critical, no sport or celebrity items, each story once.
        generated_md = register_quality.clean_brief(generated_md, day_records)
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
        
        # This path IS the disaster-recovery edition, and until the
        # 2026-10-10 audit it read keys no engine ever produced
        # ("summary_executive", a scalar "person"/"organization"), so an
        # outage rendered nothing but placeholder boilerplate while the
        # real summaries sat in memory. The real shape: the summary lives
        # at analysis["summary"], and appointments are the "people" list.
        key_dev_lines = []
        for item in key_items:
            title = item.get("title", "Corporate Event")
            summary = item.get("analysis", {}).get("summary") or "Key corporate update recorded."
            key_dev_lines.append(f"*   **{title}**: {summary}")
        if not key_dev_lines:
            key_dev_lines.append("*   *Routine market intelligence signals monitored across counterparties.*")

        risk_lines = []
        for item in high_risk_items:
            title = item.get("title", "Risk Alert")
            summary = item.get("analysis", {}).get("summary") or "Elevated risk indicator detected."
            risk_lines.append(f"*   **{title}**: {summary}")
        if not risk_lines:
            risk_lines.append("*   *No critical risk threshold breaches recorded in this run window.*")

        proc_lines = []
        for item in appointments:
            for mover in (item.get("analysis", {}).get("people") or []):
                if not isinstance(mover, dict):
                    continue
                person = mover.get("name") or "Executive"
                org = mover.get("organization") or "Counterparty"
                role = mover.get("position")
                proc_lines.append(
                    f"*   **Key Appointment**: {person}"
                    + (f" ({role})" if role else "")
                    + f" logged under {org}.")
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
        # The filter funnel: fetched candidates and undated drops come from
        # collect_all's counters; rejected is this run's Filtered writes
        # (pre-LLM guard + post-LLM relevance). Blank, not 0, when unknown
        # (e.g. seed runs that never fetched).
        "Candidates": NewsIngestionService.last_collect_stats.get("fetched", ""),
        "Rejected": "" if rejected is None else rejected,
        "Undated": NewsIngestionService.last_collect_stats.get("undated", ""),
        "Stubs": NewsIngestionService.last_collect_stats.get("stubs", ""),
        "Nigerian": NewsIngestionService.last_collect_stats.get("nigerian", ""),
        "Fresh": NewsIngestionService.last_collect_stats.get("fresh", ""),
        "Distinct": NewsIngestionService.last_collect_stats.get("distinct", ""),
        "Generated": now.strftime("%Y-%m-%d %H:%M:%S"),
        # The exact archive filename, so a reader can resolve an edition to
        # its document instead of guessing from the date.
        "Archive File": archive_name,
        "Content": md
    })

# Pure row helpers live in backend/app/pipeline/rows.py (re-exported).
# entity_key lives in backend.app.services.analytics; half the test suite
# addresses it as run_pipeline.entity_key.
from backend.app.services.analytics import entity_key  # noqa: E402,F401  (re-export)
from backend.app.pipeline.rows import (  # noqa: E402,F401  (re-export)
    build_history,
    build_sources,
    collapse_identical_rows,
    dedupe_entity_rows,
    make_node_id,
    slim_report_rows,
    top_rows,
)

def write_email_digest(articles: List[Dict[str, Any]], psc_records: List[Dict[str, Any]]) -> None:
    """The Morning Brief email edition (email_digest.json).

    Every edition covers what was added since the last email that was SENT
    (digests/last_edition.json). The send step writes that marker once the
    send succeeds (scripts/record_sent_edition.py), never this build: a
    build whose send fails or is cancelled must leave its stories for the
    next email. The 07:00 UTC run (EMAIL_EDITION=1) is the edition itself
    and alone spends the one model call for the overview and insights;
    other runs write a preview, whose edition id says so.
    """
    marker_path = os.path.join(DATA_DIR, "digests", "last_edition.json")
    edition_run = os.environ.get("EMAIL_EDITION", "").strip() == "1"
    if edition_run and os.environ.get("GITHUB_ACTIONS") and getattr(db, "use_local", False):
        # Sheets was unreachable and this run fell back to an empty local
        # file: its row IDs are not the sheet's. Build only a preview, which
        # the 08:00 send skips, so the next email carries these stories.
        logger.warning("Email digest: database on the local fallback; building a preview, not the edition")
        edition_run = False
    try:
        previous = None
        if os.path.exists(marker_path):
            with open(marker_path, "r", encoding="utf-8") as f:
                previous = json.load(f)
        edition = email_digest.build_edition(
            articles, psc_records, datetime.utcnow(), previous,
            llm=LLMService.generate_digest if edition_run else None,
            preview=not edition_run,
        )
        with open(os.path.join(DATA_DIR, "email_digest.json"), "w", encoding="utf-8") as f:
            json.dump(edition, f, ensure_ascii=False, indent=2)
        logger.info(
            f"Email digest {edition['edition']}: {edition['stats']['stories']} stories from "
            f"{edition['stats']['reports']} reports"
            + (f", overview by {edition['engines']['digest'] or 'stored text'}" if edition_run else "")
            + (f", health {edition['health']}" if any(edition['health'].values()) else "")
        )
    except Exception as exc:  # the site and the rest of the export never fail on the email
        logger.error(f"Email digest skipped: {type(exc).__name__}: {exc}")


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

    # Unpublished names (scripts/unpublish.py) go here, once: every file
    # below, the graph and the email digest are built from these rows.
    hidden = suppression.load(DATA_DIR)
    scrubbed = suppression.scrub(hidden, articles=articles, companies=companies, people=people,
                                 agencies=agencies, procurement=procurement, psc=psc_records)
    articles, companies, people = scrubbed["articles"], scrubbed["companies"], scrubbed["people"]
    agencies, procurement, psc_records = scrubbed["agencies"], scrubbed["procurement"], scrubbed["psc"]

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
        # "Unknown" / "Not Specified" are the extractor reporting that the
        # article named nobody. Left in, they shipped as tracked people:
        # person dossiers, graph nodes, and rows on the appointments board.
        and not is_placeholder_person(p.get("Name"))
        # The post captured instead of its holder ("Managing Director/Chief
        # Executive", "MD NAN") or an organisation standing in for a person
        # ("Kogi Forum"). Six such names in the live export, five of them on
        # the appointments board.
        and not is_role_or_org_name(p.get("Name"))
    ]

    # Historical residue from the retired heuristic fallback, which stamped
    # position "Officer" and the article's first organisation onto every
    # person it found. Neither was a finding, so where the fingerprint is
    # present both fields go: the person, the event and the date are real
    # and stay. "Fayose | Officer | Tinubu" becomes just "Fayose", instead
    # of asserting that one politician works for another.
    #
    # Fixed at source in LLMService._run_local_fallback, but that only helps
    # rows written from now on, and the sheet holds three months of these.
    for _row in people:
        if relevance.is_unevidenced_officer(_row.get("Position")):
            _row["Position"] = ""
            _row["Organization"] = ""
        # "N/A", "Not Specified" and friends in the organisation slot are the
        # absence of one; a blank says that without dressing it as a name.
        elif is_placeholder_person(_row.get("Organization")):
            _row["Organization"] = ""
        # Same for the post: "Not Specified" is not one.
        if is_placeholder_person(_row.get("Position")):
            _row["Position"] = ""
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
    # Validation gate. Every export below (the register, its timeline, the
    # graph, the cycle diff) sees only rows the site may publish: sourced
    # and not quarantined. Withheld rows stay in the sheet for review, and
    # only their counts are published.
    # Rows saved before rows carried their article get it back when exactly
    # one stored article names both the person and the company. Only the
    # scrubbed articles qualify, or a row could get a hidden name as its title.
    try:
        psc_records = register_quality.backfill_sources(psc_records, articles)
    except Exception as exc:
        logger.warning(f"PSC source backfill skipped ({type(exc).__name__})")
    psc_checked = register_quality.gate(collapse_identical_rows(psc_records))
    psc_records = register_quality.public_rows(psc_checked)
    psc_withheld = register_quality.withheld_summary(psc_checked)
    if psc_withheld["unsourced"] or psc_withheld["implausible"]:
        logger.info(f"Register gate withheld {psc_withheld['unsourced']} unsourced and "
                    f"{psc_withheld['implausible']} implausible row(s) from the export.")

    # Legacy duplicate rows collapse at export (the sheet keeps its audit
    # trail): one row per company, one per (person, organization). Agencies
    # too: add_agency is a bare append (one row per article mention), so
    # the export was shipping 874 rows for 313 distinct names -- 184KB to
    # the browser and duplicate nodes in the graph and dossiers.
    companies = dedupe_entity_rows(companies, ["Company"], count_key="Mention Count")
    people = dedupe_entity_rows(people, ["Name", "Organization"])
    agencies = dedupe_entity_rows(agencies, ["Agency"])

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

    # The old snapshots are scrubbed too, or a newly hidden name would be
    # published once more as "removed this cycle".
    prev = suppression.scrub(hidden, articles=_prev_snapshot("latest.json"),
                             companies=_prev_snapshot("companies.json"),
                             people=_prev_snapshot("people.json"),
                             psc=_prev_snapshot("significant_control.json"))
    changes = compute_cycle_changes(
        prev,
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

    # Side feeds (weather, FX, markets, headlines, news categories): all
    # keyless and best-effort -- see backend/app/pipeline/side_feeds.py.
    side_feeds.export_side_feeds(DATA_DIR)

    # Term/category momentum over our own articles, plus a best-effort
    # r/Nigeria social column.
    try:
        from backend.app.services.trends import compute_trends, fetch_reddit_nigeria
        trends = compute_trends(articles)
        trends["social"] = fetch_reddit_nigeria()
        trends["generated"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(os.path.join(DATA_DIR, "trends.json"), "w", encoding="utf-8") as f:
            json.dump(trends, f, default=str, indent=2)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(f"Trends export skipped: {exc}")

    # Lead images: API-supplied ones from this run, then a capped og:image
    # lookup for published rows still missing one. Never fails the export.
    try:
        image_cache = article_images.load_cache(DATA_DIR)
        image_cache.update(RUN_IMAGES)
        # Copies: the rows are the database layer's memoised dicts, and an
        # "Image" key must never ride back into a Sheets write.
        articles_sorted = [dict(a) for a in articles_sorted]
        fetched = article_images.attach_images(articles_sorted, image_cache)
        article_images.save_cache(DATA_DIR, image_cache,
                                  keep_urls=[a.get("URL") for a in articles_sorted])
        with_image = sum(1 for a in articles_sorted if a.get("Image"))
        logger.info(f"Article images: {with_image}/{len(articles_sorted)} published rows "
                    f"have one ({fetched} page lookups this run).")
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(f"Article image step skipped: {exc}")

    # Save base files
    with open(os.path.join(DATA_DIR, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(articles_sorted, f, default=str, indent=2)

    with open(os.path.join(DATA_DIR, "companies.json"), "w", encoding="utf-8") as f:
        json.dump(companies, f, default=str, indent=2)

    with open(os.path.join(DATA_DIR, "people.json"), "w", encoding="utf-8") as f:
        json.dump(people, f, default=str, indent=2)
        
    # Procurement rows carry their parsed amount at export time (never
    # stored), so the parser's coverage applies to every historical row,
    # not just rows written after it shipped. Undisclosed stays null.
    procurement_out = []
    for row in procurement:
        r = dict(row)
        parsed = analytics.parse_amount(r.get("Amount"))
        r["Amount Value"] = parsed["value"] if parsed else None
        r["Amount Currency"] = parsed["currency"] if parsed else None
        procurement_out.append(r)
    # One row per award: several outlets reporting it wrote several rows.
    procurement_out = register_quality.dedupe_procurement(procurement_out)
    with open(os.path.join(DATA_DIR, "procurement.json"), "w", encoding="utf-8") as f:
        json.dump(procurement_out, f, default=str, indent=2)

    # Agencies were already fetched and filtered for the graph step but
    # never exported like companies/people -- the agency dossier pages
    # need them. Same data, already in memory; no new query.
    with open(os.path.join(DATA_DIR, "agencies.json"), "w", encoding="utf-8") as f:
        json.dump(agencies, f, default=str, indent=2)

    with open(os.path.join(DATA_DIR, "significant_control.json"), "w", encoding="utf-8") as f:
        # Already gated above: published rows only, with canonical keys,
        # claim kind and quality flags on each.
        json.dump(psc_records, f, default=str, indent=2)
    with open(os.path.join(DATA_DIR, "register_quality.json"), "w", encoding="utf-8") as f:
        json.dump(dict(psc_withheld, generated=datetime.now().strftime("%Y-%m-%d %H:%M:%S")), f, default=str, indent=2)
        
    with open(os.path.join(DATA_DIR, "reports.json"), "w", encoding="utf-8") as f:
        json.dump(slim_report_rows(reports), f, default=str, indent=2)

    # Derived analytics over rows already in memory (every tab is memoised
    # per process): zero extra Sheets reads, zero LLM calls. Separate small
    # files, fetched on demand by the panels that need them, rather than
    # growing the big per-entity exports every cold boot already pays for.
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(os.path.join(DATA_DIR, "history.json"), "w", encoding="utf-8") as f:
        json.dump({"days": build_history(reports), "generated": stamp},
                  f, default=str, indent=2)

    with open(os.path.join(DATA_DIR, "sources.json"), "w", encoding="utf-8") as f:
        json.dump({"sources": build_sources(articles), "generated": stamp},
                  f, default=str, indent=2)

    write_email_digest(articles, psc_records)

    # Package 22 analytics: all pure functions over rows already read.
    # Entity-joined datasets (timeline, co-occurrence, movers) lean on the
    # Articles Entities column and thicken as enriched runs accrue.
    with open(os.path.join(DATA_DIR, "entity_timeline.json"), "w", encoding="utf-8") as f:
        json.dump({"entities": analytics.entity_timeline(articles), "generated": stamp},
                  f, default=str, indent=2)

    with open(os.path.join(DATA_DIR, "cooccurrence.json"), "w", encoding="utf-8") as f:
        payload = analytics.cooccurrence(articles)
        payload["generated"] = stamp
        json.dump(payload, f, default=str, indent=2)

    movers_payload = {"movers": analytics.risk_movers(articles), "window_days": 7,
                      "generated": stamp}
    with open(os.path.join(DATA_DIR, "risk_movers.json"), "w", encoding="utf-8") as f:
        json.dump(movers_payload, f, default=str, indent=2)

    # Weekly wrap: composed from rows already in memory -- Daily Reports
    # totals, the movers export (whose 7-day window IS the week) and
    # dated procurement. Zero LLM. Due from Sunday 20:00 UTC; a run on
    # any later day composes the wrap the delayed Sunday cron missed
    # (GitHub regularly starts the 23:00 slot after midnight, which the
    # old Sunday-only wall-clock gate silently skipped). The file
    # persists until the next week overwrites it; Monday's morning email
    # links it while fresh.
    now_utc = datetime.utcnow()
    try:
        from backend.app.services.weekly import compose_weekly_wrap, wrap_due_week_end
        existing_wrap = None
        wrap_json_path = os.path.join(DATA_DIR, "weekly_wrap.json")
        if os.path.exists(wrap_json_path):
            with open(wrap_json_path, encoding="utf-8") as f:
                existing_wrap = json.load(f)
        week_end = wrap_due_week_end(existing_wrap, now_utc)
        if week_end:
            wrap = compose_weekly_wrap(reports, movers_payload, procurement_out,
                                       now_utc, week_end=week_end)
            if wrap:
                with open(os.path.join(DATA_DIR, "weekly_wrap.md"), "w", encoding="utf-8") as f:
                    f.write(wrap["markdown"])
                with open(wrap_json_path, "w", encoding="utf-8") as f:
                    json.dump(wrap, f, default=str, indent=2)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(f"Weekly wrap skipped: {exc}")

    with open(os.path.join(DATA_DIR, "sectors.json"), "w", encoding="utf-8") as f:
        json.dump({"sectors": analytics.sector_rollup(companies), "generated": stamp},
                  f, default=str, indent=2)

    with open(os.path.join(DATA_DIR, "psc_timeline.json"), "w", encoding="utf-8") as f:
        json.dump({"holdings": analytics.psc_timeline(psc_records), "generated": stamp},
                  f, default=str, indent=2)

    with open(os.path.join(DATA_DIR, "procurement_rollup.json"), "w", encoding="utf-8") as f:
        payload = analytics.procurement_rollup(procurement)
        payload["generated"] = stamp
        json.dump(payload, f, default=str, indent=2)

    # The alerts ledger needs one extra tab read (memoised like the rest).
    # If that read fails, the previous alerts.json stays on disk rather
    # than being replaced with an empty window.
    try:
        alert_rows = db.get_alerts()
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(f"Alerts ledger read failed; keeping previous alerts.json: {exc}")
    else:
        with open(os.path.join(DATA_DIR, "alerts.json"), "w", encoding="utf-8") as f:
            json.dump({"alerts": suppression.without(analytics.recent_alerts(alert_rows), hidden),
                       "window_days": 90,
                       "generated": stamp}, f, default=str, indent=2)

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
    # Newest first by the Date column; legacy rows without a Date fall
    # back to append-order recency (later row index = newer).
    _dated = sorted(enumerate(procurement),
                    key=lambda p: (str(p[1].get("Date", "")), p[0]), reverse=True)
    for _, row in _dated[:20]:
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
