"""
Record the Morning Brief edition that was just sent, so the next email
starts where this one ended.

    python3 scripts/record_sent_edition.py <send-result.json> <email_digest.json> <data-dir>

Writes <data-dir>/digests/last_edition.json (the "since last email" marker
the pipeline reads) and archives the sent edition as
<data-dir>/digests/<edition>.json. It records only:
  - a real send (not a test or a dry run) that reached at least one
    subscriber or found none to send to, or a skip because this very
    edition went out earlier; and
  - the digest the send used: its edition must be the one the send names.

Anything else leaves the marker where it was, so the next email still
carries this edition's stories. Prints what it did; exits 0 either way
(nothing to record is not a failure), 1 only on unreadable input.

Standalone (json only): it runs in the deploy job, which has no Python
dependencies installed.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, Optional, Tuple


def should_record(result: Dict[str, Any], digest: Dict[str, Any]) -> Tuple[bool, str]:
    if not isinstance(result, dict) or not isinstance(digest, dict):
        return False, "unreadable send result or digest"
    if result.get("test") or result.get("dry_run"):
        return False, "test or dry run"
    edition = str(result.get("edition") or "")
    if not edition or edition != str(digest.get("edition") or ""):
        return False, f"sent edition {edition or '?'} is not this digest ({digest.get('edition') or '?'})"
    # This very edition went out earlier (a retry after the marker failed to
    # save): record it now.
    if result.get("skipped") in ("edition_already_sent", "already_sent_today"):
        if "through_id" not in digest:
            return False, "the digest has no through_id"
        return True, f"recorded {edition} (sent earlier)"
    if result.get("skipped"):
        return False, f"send skipped ({result.get('skipped')})"
    if "sent" not in result:
        return False, f"the response does not say what was sent ({result.get('error') or 'no count'})"
    # A per-recipient error (say, Gmail's daily cap) still means the edition went out.
    sent = int(result.get("sent") or 0)
    recipients = int(result.get("recipients") or 0)
    if sent == 0 and recipients > 0:
        return False, "no copy was delivered"
    if "through_id" not in digest:
        return False, "the digest has no through_id"
    return True, f"recorded {edition} ({sent} sent)"


def marker(digest: Dict[str, Any], result: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "edition": digest["edition"],
        "through_id": digest["through_id"],
        "built_at": digest.get("built_at", ""),
        "psc_keys": list(digest.get("psc_keys") or []),
        "sent_day": str(result.get("day") or ""),
        "sent": int(result.get("sent") or 0),
    }


def record(result: Dict[str, Any], digest: Dict[str, Any], data_dir: str) -> Tuple[bool, str]:
    ok, why = should_record(result, digest)
    if not ok:
        return False, why
    out = os.path.join(data_dir, "digests")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, f"{digest['edition']}.json"), "w", encoding="utf-8") as f:
        json.dump(digest, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out, "last_edition.json"), "w", encoding="utf-8") as f:
        json.dump(marker(digest, result), f, indent=2)
    return True, why


def _load(path: str) -> Optional[Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def main(argv: list) -> int:
    if len(argv) != 4:
        print(__doc__.strip().splitlines()[3])
        return 1
    result, digest = _load(argv[1]), _load(argv[2])
    if result is None or digest is None:
        print(f"record-sent: could not read {argv[1] if result is None else argv[2]}; marker unchanged")
        return 1
    ok, why = record(result, digest, argv[3])
    print(f"record-sent: {why}" if ok else f"record-sent: not recorded: {why}; marker unchanged")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
