#!/usr/bin/env python3
"""
Measure the live extractor against the gold set and print a number.

The GEPA optimiser (scripts/optimise_extraction.py) can already *improve*
the extractor, but nothing could *measure* it: there was no way to answer
"how good is extraction today?" without kicking off an optimisation run.
This script is that harness -- read-only, no artifact writes, one score.

It scores the production path (`LLMService.analyze_article`, the same
cascade the pipeline runs), so the number reflects what actually ships --
not just the DSPy program the optimiser tunes. It therefore needs at
least one configured LLM provider and spends one extraction call per gold
example; run it manually or from a dispatch-only workflow, never in the
per-PR test suite.

Exit codes: 0 = measured; 2 = regression against --baseline beyond
--tolerance; 3 = nothing to measure (no verified examples).
"""
import argparse
import json
import os
import sys
from typing import Any, Dict, List, Tuple

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

DEFAULT_GOLD = os.path.join(os.path.dirname(__file__), "..", "evals", "extraction_gold.jsonl")


def load_gold_records(path: str, include_drafts: bool = False) -> Tuple[List[Dict[str, Any]], int]:
    """Gold records as plain dicts; archive-hint fields dropped.

    Unverified drafts are skipped unless explicitly included: a draft
    nobody corrected is not a label, and a score against drafts mostly
    measures agreement with the model that wrote them.
    """
    records = []
    skipped = 0
    with open(path, "r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{line_no}: invalid JSON ({exc})")
            verified = bool(str(record.get("verified_by") or "").strip())
            if not verified and not include_drafts:
                skipped += 1
                continue
            records.append({k: v for k, v in record.items() if not k.startswith("_")})
    return records, skipped


def summarise(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate per-example results into the printed/JSON summary."""
    if not results:
        return {"examples": 0, "mean_score": None, "disqualified": 0, "perfect": 0}
    scores = [r["score"] for r in results]
    return {
        "examples": len(results),
        "mean_score": round(sum(scores) / len(scores), 4),
        "disqualified": sum(1 for s in scores if s == 0.0),
        "perfect": sum(1 for s in scores if s == 1.0),
        "min_score": min(scores),
    }


def _score_one(record: Dict[str, Any]) -> Dict[str, Any]:
    from backend.app.services.llm import LLMService
    from evals.metric import extraction_metric

    prediction = LLMService.analyze_article(
        record.get("title", ""), record.get("article_text", "")
    )
    result = extraction_metric(record, prediction)
    score = result.score if hasattr(result, "score") else result[0]
    feedback = result.feedback if hasattr(result, "feedback") else result[1]
    return {
        "title": record.get("title", "")[:80],
        "score": float(score),
        "feedback": str(feedback),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gold", default=DEFAULT_GOLD)
    parser.add_argument("--include-drafts", action="store_true",
                        help="Also score unverified drafts. The number is then "
                             "labelled DRAFT-ONLY: it mostly measures agreement "
                             "with the model that wrote the drafts.")
    parser.add_argument("--json-out", default=None,
                        help="Write the summary and per-example rows as JSON.")
    parser.add_argument("--baseline", default=None,
                        help="A previous --json-out file; exit 2 if the mean "
                             "score regressed beyond --tolerance.")
    parser.add_argument("--tolerance", type=float, default=0.02)
    args = parser.parse_args()

    if not os.path.exists(args.gold):
        raise SystemExit(f"No gold set at {args.gold}.")

    records, skipped = load_gold_records(args.gold, include_drafts=args.include_drafts)
    if skipped:
        print(f"skipped {skipped} unverified draft(s) -- set verified_by to include them, "
              f"or pass --include-drafts for a caveated number")
    if not records:
        print("Nothing to measure: no verified gold examples. "
              "Label drafts by setting verified_by (see evals/README.md).")
        return 3

    label = "DRAFT-ONLY (unverified labels included)" if args.include_drafts else "verified gold"
    print(f"scoring {len(records)} example(s) against the live extractor [{label}] ...")

    results = []
    for i, record in enumerate(records, 1):
        row = _score_one(record)
        results.append(row)
        marker = "OK " if row["score"] == 1.0 else ("ZERO" if row["score"] == 0.0 else f"{row['score']:.2f}")
        print(f"  [{i:>2}/{len(records)}] {marker:>4}  {row['title']}")
        if row["score"] < 1.0:
            print(f"          {row['feedback'][:160]}")

    summary = summarise(results)
    summary["label"] = label
    print(f"\nmean score: {summary['mean_score']}  "
          f"(perfect: {summary['perfect']}/{summary['examples']}, "
          f"disqualified-at-zero: {summary['disqualified']})")

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump({"summary": summary, "results": results}, fh, indent=2)
        print(f"wrote {args.json_out}")

    if args.baseline and os.path.exists(args.baseline):
        with open(args.baseline, encoding="utf-8") as fh:
            base = json.load(fh).get("summary", {})
        base_mean = base.get("mean_score")
        if base_mean is not None and summary["mean_score"] is not None \
                and summary["mean_score"] < base_mean - args.tolerance:
            print(f"REGRESSION: mean {summary['mean_score']} vs baseline {base_mean} "
                  f"(tolerance {args.tolerance})")
            return 2
        print(f"no regression vs baseline mean {base_mean}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
