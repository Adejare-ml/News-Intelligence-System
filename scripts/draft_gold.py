#!/usr/bin/env python3
"""
Turn captured extractor inputs into gold-set scaffolding for a human to correct.

This writes *drafts*, never labels. Every record comes out with
`verified_by: null`, and `scripts/optimise_extraction.py` skips those, so
nothing produced here can reach GEPA until a person has read the article and
signed the record off.

That separation is deliberate. Seeding labels from model output and optimising
against them without correction would teach the optimiser to reproduce today's
behaviour, mistakes included, and report an improving score while doing it.

Where the corpus URL matches a row in the published archive, the previous
pipeline's Category / Risk Score / Summary are carried across as **hints** under
`_archive_hint` -- namespaced, and dropped by the loader. They are not written
into the answer fields, because a labeller handed a plausible pre-filled answer
tends to approve it rather than check it. The hint sits beside the blank so the
labeller has to type the value themselves.
"""
import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CORPUS_GLOB = os.path.join(REPO, "evals", "corpus", "*.jsonl")
GOLD = os.path.join(REPO, "evals", "extraction_gold.jsonl")
ARCHIVE = os.path.join(REPO, "backend", "app", "static", "data", "latest.json")

# Every field the metric reads, blank. Present so labelling is correcting a
# structure rather than recalling a schema.
BLANK = {
    "relevant": None,
    "category": None,
    "event_type": None,
    "risk_score": None,
    "risk_level": None,
    "importance_score": None,
    "summary": "",
    "organizations": [],
    "people": [],
    "significant_control": [],
    "procurement": None,
}


def read_jsonl(path):
    records = []
    if not os.path.exists(path):
        return records
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("//"):
                records.append(json.loads(line))
    return records


def archive_hints(archive_path):
    """Map url -> previous pipeline output, for context only."""
    if not os.path.exists(archive_path):
        return {}
    with open(archive_path, "r", encoding="utf-8") as fh:
        rows = json.load(fh)
    hints = {}
    for row in rows:
        url = row.get("URL") or row.get("url")
        if not url:
            continue
        hints[url] = {
            "note": "PREVIOUS MODEL OUTPUT, NOT A LABEL. Verify against the article.",
            "category": row.get("Category"),
            "risk_score": row.get("Risk Score"),
            "summary": row.get("Summary"),
        }
    return hints


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default=CORPUS_GLOB)
    parser.add_argument("--gold", default=GOLD)
    parser.add_argument("--archive", default=ARCHIVE)
    parser.add_argument("--limit", type=int, default=0, help="0 = no limit")
    args = parser.parse_args()

    corpus = []
    for path in sorted(glob.glob(args.corpus)):
        corpus.extend(read_jsonl(path))
    if not corpus:
        raise SystemExit(
            f"No corpus records under {args.corpus}. The pipeline samples inputs "
            "into evals/corpus as it runs; scripts/backfill_eval_corpus.py can "
            "recover some from the archive."
        )

    existing = read_jsonl(args.gold)
    # Keyed on url when present, title otherwise, so re-running as the corpus
    # grows appends only what is new and never disturbs a verified record.
    seen = {(r.get("url") or r.get("title")) for r in existing}
    hints = archive_hints(args.archive)

    drafted = 0
    with open(args.gold, "a", encoding="utf-8") as out:
        for record in corpus:
            key = record.get("url") or record.get("title")
            if not key or key in seen:
                continue
            if not record.get("article_text"):
                continue

            draft = {
                "title": record.get("title", ""),
                "article_text": record.get("article_text", ""),
                "url": record.get("url", ""),
                "source": record.get("source", ""),
            }
            draft.update(BLANK)
            draft["verified_by"] = None
            draft["verified_at"] = None
            if key in hints:
                draft["_archive_hint"] = hints[key]

            out.write(json.dumps(draft, ensure_ascii=False) + "\n")
            seen.add(key)
            drafted += 1
            if args.limit and drafted >= args.limit:
                break

    print(f"drafted {drafted} new record(s) into {args.gold}")
    print(f"{len(existing)} record(s) were already there and were left alone")
    if drafted:
        print(
            "\nThese are NOT labels. Each needs the article read and the fields "
            "corrected, then verified_by set.\nThe optimiser skips every record "
            "where verified_by is empty -- see evals/README.md."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
