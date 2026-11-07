"""
Take a person or company off the site.

    python3 scripts/unpublish.py "<person or company name>" [--reason "..."] [--kind person|company]

Adds the name to backend/app/static/data/suppressed.json. Commit and push
that file: the next site build stops showing the name (pages, search,
sitemap), and the next pipeline run drops it from every exported file and
the email digest. The rows stay in the Google Sheet; nothing is deleted.

Matching is by whole words, ignoring case, initials and honorifics, so
"Aliko Dangote" also hides "Alhaji Aliko Dangote". Use the full name: a
single common word would hide every record that contains it.

The name and the reason are public in the repository (the site does not
serve the file), so keep the reason generic, such as "dispute upheld".

To publish a name again, delete its entry from suppressed.json.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date
from typing import List, Optional

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "backend", "app", "static", "data")


def _key(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip().lower()


def main(argv: Optional[List[str]] = None) -> str:
    parser = argparse.ArgumentParser(description="Hide a person or company from AURA.")
    parser.add_argument("name")
    parser.add_argument("--reason", default="",
                        help="kept in a public file: keep it generic, e.g. 'dispute upheld'")
    parser.add_argument("--kind", choices=("person", "company"))
    parser.add_argument("--data-dir", default=DATA_DIR)
    parser.add_argument("--today", default=None, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    name = re.sub(r"\s+", " ", args.name).strip()
    # The site and the export ignore names this short (they would match
    # inside unrelated words), so saving one would hide nothing.
    if len(name) < 3:
        return f"'{name}' is too short to match safely; use the full name."

    path = os.path.join(args.data_dir, "suppressed.json")
    entries = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            entries = json.load(f)
    if any(_key(str(e.get("name", ""))) == _key(name) for e in entries):
        return f"'{name}' is already unpublished."

    entry = {"name": name}
    if args.kind:
        entry["kind"] = args.kind
    entry["added"] = args.today or date.today().isoformat()
    entry["reason"] = args.reason.strip()
    entries.append(entry)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return f"Unpublished '{name}'. Commit {os.path.relpath(path)} and push to take it off the site."


if __name__ == "__main__":
    print(main())
    sys.exit(0)
