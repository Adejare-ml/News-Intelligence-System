#!/usr/bin/env python3
"""
Run GEPA against the extraction gold set and keep the result only if it wins.

Never called by the scheduled pipeline. GEPA's cost is many LLM calls per
candidate instruction, which is fine for a weekly job with an explicit budget
and completely wrong for a job that runs four times a day.

The contract with the workflow that calls it:

  * it only writes the artifact when the candidate beats the incumbent on the
    held-out split, so a run that improves nothing leaves the tree clean and no
    PR is opened;
  * it writes a human-readable summary to --summary-out for the PR body;
  * exit 0 means "ran successfully", not "improved". The workflow decides what
    to do by looking at whether the artifact changed.

Scoring the incumbent and the candidate on a split GEPA never saw is the whole
point. Optimisers are very good at winning on the data they are shown.
"""
import argparse
import json
import os
import random
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import dspy  # noqa: E402

from backend.app.core.config import settings  # noqa: E402
from backend.app.services.dspy_extract import (  # noqa: E402
    ARTIFACT_PATH,
    IntelligenceExtractor,
    load_extractor,
)
from evals.metric import extraction_metric  # noqa: E402

DEFAULT_GOLD = os.path.join(os.path.dirname(__file__), "..", "evals", "extraction_gold.jsonl")


def load_gold(path):
    """
    Read the gold set, keeping only records a person has signed off.

    `verified_by` is the whole point. scripts/draft_gold.py writes scaffolding
    pre-filled from the corpus and, where available, hints taken from previous
    model output -- and a draft that nobody corrected is not a label. Optimising
    against uncorrected drafts would teach GEPA to reproduce today's behaviour,
    mistakes included, while reporting a rising score for doing it. A number
    that looks rigorous and measures nothing is worse than no number.

    Drafts are therefore skipped here rather than merely discouraged in the
    documentation. Fields beginning with "_" (the archive hints) are dropped
    too: they are labelling aids, not part of the expected extraction.
    """
    examples = []
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

            if not str(record.get("verified_by") or "").strip():
                skipped += 1
                continue

            record = {k: v for k, v in record.items() if not k.startswith("_")}
            examples.append(
                dspy.Example(**record).with_inputs("title", "article_text")
            )
    return examples, skipped


def split(examples, val_fraction=0.3, seed=0):
    """Deterministic split, so runs are comparable week to week."""
    shuffled = list(examples)
    random.Random(seed).shuffle(shuffled)
    cut = max(1, int(len(shuffled) * val_fraction))
    return shuffled[cut:], shuffled[:cut]


def mean_score(program, examples):
    total = 0.0
    for example in examples:
        prediction = program(title=example.title, article_text=example.article_text)
        result = extraction_metric(example, prediction)
        total += result.score if hasattr(result, "score") else result[0]
    return total / len(examples) if examples else 0.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--gold", default=DEFAULT_GOLD)
    parser.add_argument("--artifact", default=ARTIFACT_PATH)
    parser.add_argument("--summary-out", default=None)
    parser.add_argument("--max-metric-calls", type=int,
                        default=settings.GEPA_MAX_METRIC_CALLS)
    parser.add_argument("--val-fraction", type=float, default=0.3)
    args = parser.parse_args()

    if not os.path.exists(args.gold):
        raise SystemExit(
            f"No gold set at {args.gold}. GEPA cannot optimise against nothing -- "
            "label some articles first (see evals/README.md)."
        )

    examples, skipped = load_gold(args.gold)
    if skipped:
        print(f"skipped {skipped} unverified draft(s) -- set verified_by to include them")

    # Below this, a win on the validation split is noise rather than evidence.
    if len(examples) < 10:
        detail = (f" ({skipped} unverified draft(s) were skipped)" if skipped else "")
        raise SystemExit(
            f"Only {len(examples)} verified gold examples{detail}. Refusing to run: a "
            "validation split this small cannot distinguish a better prompt from a "
            "lucky one."
        )

    trainset, valset = split(examples, args.val_fraction)
    print(f"verified={len(examples)} unverified={skipped} "
          f"train={len(trainset)} val={len(valset)}")

    from backend.app.services.llm import LLMService
    LLMService._configure_dspy()

    incumbent = load_extractor(args.artifact)
    incumbent_score = mean_score(incumbent, valset)
    print(f"incumbent val score: {incumbent_score:.4f}")

    reflection_model = settings.GEPA_REFLECTION_MODEL
    reflection_lm = dspy.LM(reflection_model) if reflection_model else None

    optimiser = dspy.GEPA(
        metric=extraction_metric,
        max_metric_calls=args.max_metric_calls,
        reflection_lm=reflection_lm,
        track_stats=True,
    )
    candidate = optimiser.compile(
        IntelligenceExtractor(), trainset=trainset, valset=valset
    )

    candidate_score = mean_score(candidate, valset)
    print(f"candidate val score: {candidate_score:.4f}")

    improved = candidate_score > incumbent_score
    if improved:
        os.makedirs(os.path.dirname(args.artifact), exist_ok=True)
        candidate.save(args.artifact)
        print(f"improved by {candidate_score - incumbent_score:+.4f}; wrote {args.artifact}")
    else:
        print("no improvement; leaving the committed artifact untouched")

    if args.summary_out:
        with open(args.summary_out, "w", encoding="utf-8") as fh:
            fh.write(
                f"| | score on held-out val ({len(valset)} examples) |\n|---|---|\n"
                f"| incumbent | {incumbent_score:.4f} |\n"
                f"| candidate | {candidate_score:.4f} |\n"
                f"| delta | {candidate_score - incumbent_score:+.4f} |\n\n"
                f"Budget: {args.max_metric_calls} metric calls. "
                f"Train split: {len(trainset)} examples.\n\n"
                + ("The candidate won on data GEPA did not optimise against.\n"
                   if improved else
                   "No improvement; the committed artifact is unchanged.\n")
            )

    return 0


if __name__ == "__main__":
    sys.exit(main())
