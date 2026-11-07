"""
Decide whether a scheduled pipeline run should go ahead or skip itself.

    gh run list --workflow news_scheduler.yml --limit 30 \\
        --json databaseId,createdAt,updatedAt,status,event \\
      | python3 scripts/scheduler_guard.py --self-id "$RUN_ID" >> "$GITHUB_OUTPUT"

Prints two lines, `go=true|false` and `reason=...`, ready for
$GITHUB_OUTPUT.

GitHub's cron reaches this repo hours late, so a scheduled run often
arrives long after its slot. It skips only when ANOTHER run that did real
work started in the last 150 minutes: the data is fresh and a second run
would just repeat it. A run did real work if it is still queued or running,
or finished after more than two minutes. A run that skipped itself finishes
in seconds, so it never makes a later run skip (it used to: one late run
made every later slot skip, as on 6 Nov 2026).

The watchdog asks the same question over six hours (--window-minutes 360):
go=true there means nothing real ran in that time.

Standalone (json only): the guard job installs no Python dependencies.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

WINDOW_MINUTES = 150
# Skipped runs take 7-13 s; a real pipeline run takes about ten minutes.
REAL_WORK_SECONDS = 120


def _when(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def did_real_work(run: Dict[str, Any]) -> bool:
    if run.get("status") != "completed":
        return True
    took = _when(run["updatedAt"]) - _when(run["createdAt"])
    return took.total_seconds() > REAL_WORK_SECONDS


def decide(
    runs: List[Dict[str, Any]],
    self_id: int,
    now: datetime,
    window_minutes: int = WINDOW_MINUTES,
) -> Tuple[bool, str]:
    since = now - timedelta(minutes=window_minutes)
    recent: Optional[Dict[str, Any]] = None
    for run in runs:
        if int(run["databaseId"]) == int(self_id):
            continue
        if _when(run["createdAt"]) >= since and did_real_work(run):
            if recent is None or run["createdAt"] > recent["createdAt"]:
                recent = run
    if recent is None:
        return True, f"no other run did real work in the last {window_minutes} minutes"
    return False, (
        f"run {recent['databaseId']} ({recent.get('event') or '?'}, {recent.get('status')}) "
        f"started at {recent['createdAt']}, within the last {window_minutes} minutes"
    )


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--self-id", type=int, required=True, help="this run's id (github.run_id)")
    parser.add_argument("--window-minutes", type=int, default=WINDOW_MINUTES)
    parser.add_argument("--now", help="ISO time to judge from (default: now); for tests")
    args = parser.parse_args(argv)

    runs = json.load(sys.stdin)
    now = _when(args.now) if args.now else datetime.now(timezone.utc)
    go, reason = decide(runs, args.self_id, now, args.window_minutes)
    print(f"go={'true' if go else 'false'}")
    print(f"reason={reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
