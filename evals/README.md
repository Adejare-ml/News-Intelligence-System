# Extraction evaluation set

This directory holds the only thing that makes optimisation meaningful: examples
of what a *correct* extraction looks like.

Without it, GEPA has nothing to improve against, and any number it reports is a
number about itself. The library integration in `backend/app/services/dspy_extract.py`
took a day; this set is the part that decides whether any of it was worth doing.

## Why it had to be built from scratch

The archive could not supply it. Everything persisted about an article —
`Title`, `Summary`, `Category`, `Risk Score` — is **model output**. The article
body, which is the input the extractor is actually judged on, was discarded
after analysis. There was no stored (input → correct output) pair anywhere.

Two things now feed this directory:

- `run_pipeline.capture_eval_input` samples one analysed article in
  `EVAL_CAPTURE_RATE` (default 10) into `corpus/YYYYMM.jsonl`, recording the
  inputs rather than the outputs.
- `scripts/backfill_eval_corpus.py` re-fetches bodies for URLs already in
  `backend/app/static/data/latest.json`. Expect partial success — paywalls and
  rotated URLs will lose some.

## Labelling

`extraction_gold.jsonl`, one JSON object per line:

```json
{
  "title": "Otedola increases stake in First HoldCo",
  "article_text": "Full article body as the extractor sees it...",
  "url": "https://...",
  "relevant": true,
  "category": "Company",
  "event_type": "Ownership Change",
  "risk_score": 70,
  "risk_level": "High",
  "importance_score": 75,
  "organizations": [{"name": "First HoldCo", "type": "company"}],
  "people": [],
  "significant_control": [
    {"name": "Femi Otedola", "organization": "First HoldCo", "percentage": null}
  ],
  "procurement": null,
  "labelled_by": "adejare",
  "labelled_at": "2026-08-10"
}
```

Rules that matter when labelling, because the metric enforces them and GEPA will
be shaped by them:

1. **Never write a percentage the article does not state.** `null` is the
   correct answer far more often than a number. The metric scores any
   percentage absent from the article body as zero for the whole example.
2. **Never list the publication** among `organizations`. The Guardian reporting
   on Dangote is not a participant.
3. A person with significant control goes in `significant_control` **only** —
   never duplicated into `people`.
4. `relevant` is the gate. If it is wrong the example scores zero regardless of
   everything else, which mirrors what the field actually does in production.

Record who labelled each example. A gold set nobody can attribute is a gold set
nobody can correct.

## Size

`scripts/optimise_extraction.py` refuses to run below 10 examples, because a
validation split that small cannot separate a better prompt from a lucky one.
Target 60–100, split 70/30 train/validation by the script.

## Running the optimiser

```bash
python scripts/optimise_extraction.py --max-metric-calls 20 --summary-out /tmp/summary.md
```

It scores the incumbent artifact and the candidate on a split GEPA never sees,
and writes `backend/app/services/prompts/extraction_gepa.json` **only** if the
candidate wins. The weekly workflow opens a draft PR when that file changes; it
never pushes to `main`.
