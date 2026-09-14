# Roadmap — deferred and future work

The single place where deliberately-deferred work is recorded. Items here
were considered and postponed with reasons, not forgotten; when one ships,
remove it. (Previously the only record of these was buried inside the
completed implementation plan `TIER1_REDESIGN_PLAN.md`.)

## Frontend

- **Retire the legacy PSC modal** (`#psc-modal` in index.html + its
  `renderPSCTableRows`/SVG-map code in app.js). The `#register` section
  and the dossier pages now cover almost all of it; the modal's unique
  bits (75%+ / cross-holdings chips, Filing Ref column, compliance-brief
  export) should be folded into `#register` first.
- **Notes and investigations** (Tier 1 Slice H remainder): per-device
  notes on entities and a saved-investigation view under `aura:local:v1`.
- **Graph**: clustering, WebGL rendering, multi-hop pathfinding beyond
  BFS — all explicitly out of Slice G's scope.
- **Dossiers**: employment history / org-chart view; Drawer and
  ConfidenceBadge components from the original plan.
- **True path-based URLs** — requires a host with rewrites; hash routes
  are the deliberate GitHub Pages answer for now.
- **Multi-user sync** for watchlists/dismissals — needs an account
  system; everything is per-browser localStorage today, and every
  surface labels it so.

## Pipeline / backend

- **Real extraction confidence score** — surfaced per record instead of
  the extractor's self-reported risk fields.
- **Claim-verification taxonomy** — distinguishing "filed with CAC"
  from "reported by one newspaper".
- **Entity-resolution review UI** — merge/split of entity aliases with a
  human in the loop (the exporter's suffix-normalised dedupe is the
  automated 90%).
- **Semantic search service** — `backend/app/services/search.py`
  (pgvector cosine search) was removed as dead code: no endpoint or
  caller ever reached it. Reintroduce behind an authenticated
  `GET /search` if the Docker/API mode grows a real consumer.
- **Postgres as an API data source** — the Celery tasks write
  `Article`/`Event`/`Alert` rows nobody reads; either wire endpoints to
  them or remove the tasks (see the README's Docker section).
- **SEARCH_TOPICS as versioned config** — the query list is a class
  attribute; a config file would let deploys tune coverage without a
  code change.

## Evals

- **Label the gold set** — `evals/extraction_gold.jsonl` holds 16 drafts
  with `verified_by: null`; both the GEPA optimiser and a meaningful
  `scripts/run_eval.py` number are gated on ≥10 verified examples.
- **Corpus supply** — in-run capture yields mostly sub-200-char blurbs;
  `scripts/backfill_eval_corpus.py` (full-body re-fetch) is the workable
  primary source.
- **Regression gate in CI** — once a verified baseline exists, run
  `scripts/run_eval.py --baseline` in a scheduled (not per-PR) workflow.

## Ops

- **Accessibility / performance / security audit pass** over the whole
  dashboard as its own project (the "Tier 5 follow-on" from the plan).
