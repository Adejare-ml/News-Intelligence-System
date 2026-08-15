#!/usr/bin/env python3
"""
Check the gold set against the rules the metric enforces.

A wrong label is not a small problem here. The metric scores a fabricated
percentage at zero, so a *label* containing a percentage the article never
stated would punish the model for being right. GEPA would then optimise toward
the mistake. Errors in the gold set propagate into the prompt.

Exits non-zero listing file:line for each problem, so it can gate the weekly
optimisation workflow.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend.app.services.relevance import (  # noqa: E402
    is_publication_or_furniture,
    off_topic_reason,
)

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
GOLD = os.path.join(REPO, "evals", "extraction_gold.jsonl")

# Mirrors the Literal sets on ExtractIntelligence. Imported values would be
# better, but that costs a dspy import for a script that should stay cheap.
CATEGORIES = {"Company", "Government", "Legal", "Other"}
EVENT_TYPES = {
    "PSC Change", "Ownership Change", "Appointment", "Merger", "Acquisition",
    "Restructuring", "Procurement", "Earnings", "Audit", "Policy", "Corruption", "Other",
}
RISK_LEVELS = {"Low", "Medium", "High", "Critical"}

MIN_ARTICLE_CHARS = 200


def norm(value):
    return " ".join(str(value or "").split()).strip().lower()


def check(record, line_no, path):
    """Return a list of 'path:line: problem' strings."""
    problems = []

    def fail(message):
        problems.append(f"{path}:{line_no}: {message}")

    text = record.get("article_text") or ""
    if not text.strip():
        fail("article_text is empty -- the extractor has nothing to read")
    elif len(text) < MIN_ARTICLE_CHARS:
        fail(f"article_text is only {len(text)} chars; likely a failed fetch "
             f"or a consent wall rather than an article")

    verified = str(record.get("verified_by") or "").strip()

    # Enum fields. Only checked once someone claims the record is done --
    # drafts are legitimately blank.
    if verified:
        for field, allowed in (("category", CATEGORIES),
                               ("event_type", EVENT_TYPES),
                               ("risk_level", RISK_LEVELS)):
            value = record.get(field)
            if value is not None and value not in allowed:
                fail(f"{field}={value!r} is not one of {sorted(allowed)}")

        if record.get("relevant") is None:
            fail("relevant is null on a verified record; it decides whether "
                 "anything is published and cannot be left blank")

    haystack = norm(text)
    psc = record.get("significant_control") or []
    for holder in psc:
        for field in ("percentage", "direct_percentage", "indirect_percentage"):
            value = holder.get(field)
            if not value:
                continue
            digits = norm(value).replace("%", "").strip()
            if digits and digits not in haystack:
                fail(f"{holder.get('name') or 'a holder'} has {field}={value!r}, "
                     f"which does not appear in article_text. Labels must never "
                     f"state a figure the article does not.")

    for org in record.get("organizations") or []:
        name = org.get("name")
        if is_publication_or_furniture(name):
            fail(f"organizations contains {name!r}, which is the publication or "
                 f"page furniture, not a party to the story")

    psc_keys = {(norm(h.get("name")), norm(h.get("organization"))) for h in psc}
    people_keys = {(norm(p.get("name")), norm(p.get("organization")))
                   for p in record.get("people") or []}
    for leaked in sorted(psc_keys & people_keys):
        fail(f"{leaked[0]!r} appears in both people and significant_control; "
             f"a person with significant control belongs only in the latter")

    if record.get("relevant") is True:
        reason = off_topic_reason(record.get("title"), record.get("summary"))
        if reason is not None:
            fail(f"relevant=true but this looks like {reason.topic} coverage "
                 f"(matched: {', '.join(reason.matched)})")

    return problems


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--gold", default=GOLD)
    parser.add_argument("--require-verified", type=int, default=0,
                        help="Fail unless at least this many records are verified")
    args = parser.parse_args()

    if not os.path.exists(args.gold):
        raise SystemExit(f"No gold set at {args.gold}")

    problems, total, verified = [], 0, 0
    with open(args.gold, "r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                problems.append(f"{args.gold}:{line_no}: invalid JSON ({exc})")
                continue
            total += 1
            if str(record.get("verified_by") or "").strip():
                verified += 1
            problems.extend(check(record, line_no, args.gold))

    print(f"{total} record(s), {verified} verified, {total - verified} draft(s)")

    if problems:
        print(f"\n{len(problems)} problem(s):\n")
        for problem in problems:
            print(f"  {problem}")
        return 1

    if args.require_verified and verified < args.require_verified:
        print(f"\nOnly {verified} verified record(s); {args.require_verified} required.")
        return 1

    print("no problems found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
