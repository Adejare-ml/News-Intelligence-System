"""A late scheduled run skips only when a run that did real work started recently.

The old guard skipped when any run had been created since its slot hour, so
one late run (or even another skipped run) made every later slot skip. The
history below is what GitHub's cron actually did on 6-7 Nov 2026 (UTC).
Manual runs never reach decide(): the workflow lets them through first.
"""
import io
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import scheduler_guard as guard  # noqa: E402


def at(text):
    return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def run(run_id, created, seconds, status="completed", event="schedule"):
    start = at(created)
    return {
        "databaseId": run_id,
        "createdAt": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "updatedAt": (start + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": status,
        "event": event,
    }


# 3-5 Nov: each late cron run was the only run near its time.
EARLIER = [
    run(101, "2026-11-03 15:20:00", 700),
    run(102, "2026-11-03 21:40:00", 650),
    run(103, "2026-11-04 03:05:00", 720),
    run(104, "2026-11-04 14:30:00", 690),
    run(105, "2026-11-05 02:50:00", 660),
    run(106, "2026-11-05 15:10:00", 710),
]
# 6 Nov: the "11 7" cron started 14:58 and ran ~11 minutes.
MORNING = run(201, "2026-11-06 14:58:00", 660)


def test_the_late_morning_run_goes_when_nothing_ran_recently():
    me = run(201, "2026-11-06 14:58:00", 0, status="in_progress")
    go, _ = guard.decide(EARLIER + [me], 201, at("2026-11-06 14:58:05"))
    assert go


def test_the_13_slot_arriving_at_1955_now_runs():
    # The old guard skipped it because the 14:58 run was created after 13:00.
    me = run(202, "2026-11-06 19:55:00", 0, status="in_progress")
    go, why = guard.decide(EARLIER + [MORNING, me], 202, at("2026-11-06 19:55:07"))
    assert go, why


def test_the_17_slot_runs_when_only_a_skipped_run_came_before_it():
    # What really happened: the 19:55 run skipped in ~8 s, and the old guard
    # then skipped the 22:06 run because of that skipped run.
    skipped = run(202, "2026-11-06 19:55:00", 8)
    me = run(203, "2026-11-06 22:06:00", 0, status="in_progress")
    go, why = guard.decide(EARLIER + [MORNING, skipped, me], 203, at("2026-11-06 22:06:06"))
    assert go, why


def test_the_17_slot_skips_when_the_1955_run_did_real_work():
    # Under the new rule the 19:55 run runs, so 22:06 (131 min later) is
    # covered by it and skips.
    real = run(202, "2026-11-06 19:55:00", 680)
    me = run(203, "2026-11-06 22:06:00", 0, status="in_progress")
    go, why = guard.decide(EARLIER + [MORNING, real, me], 203, at("2026-11-06 22:06:06"))
    assert not go
    assert "202" in why


def test_the_23_slot_after_midnight_runs():
    history = EARLIER + [MORNING, run(202, "2026-11-06 19:55:00", 680), run(203, "2026-11-06 22:06:00", 9)]
    me = run(204, "2026-11-07 02:43:00", 0, status="in_progress")
    go, why = guard.decide(history + [me], 204, at("2026-11-07 02:43:05"))
    assert go, why


def test_a_real_run_40_minutes_ago_means_skip():
    other = run(301, "2026-11-07 06:30:00", 700, event="workflow_dispatch")
    me = run(302, "2026-11-07 07:10:00", 0, status="in_progress")
    go, _ = guard.decide([other, me], 302, at("2026-11-07 07:10:00"))
    assert not go


def test_a_run_still_in_progress_counts_as_real_work():
    other = run(301, "2026-11-07 07:07:00", 30, status="in_progress", event="workflow_dispatch")
    go, _ = guard.decide([other], 302, at("2026-11-07 07:12:00"))
    assert not go


def test_a_queued_run_counts_as_real_work():
    other = run(301, "2026-11-07 07:07:00", 0, status="queued", event="workflow_dispatch")
    go, _ = guard.decide([other], 302, at("2026-11-07 07:12:00"))
    assert not go


def test_only_skipped_runs_recently_means_go():
    runs = [run(301, "2026-11-07 06:30:00", 9), run(302, "2026-11-07 06:50:00", 13)]
    go, _ = guard.decide(runs, 303, at("2026-11-07 07:10:00"))
    assert go


def test_a_real_run_just_over_150_minutes_ago_does_not_count():
    other = run(301, "2026-11-07 04:39:00", 700)
    go, _ = guard.decide([other], 302, at("2026-11-07 07:10:00"))
    assert go


def test_the_run_itself_never_counts():
    me = run(302, "2026-11-07 07:10:00", 0, status="in_progress")
    go, _ = guard.decide([me], 302, at("2026-11-07 07:10:05"))
    assert go


def test_the_window_can_be_widened_for_the_watchdog():
    other = run(301, "2026-11-07 03:00:00", 700)
    now = at("2026-11-07 07:51:00")
    assert guard.decide([other], 0, now)[0]
    assert not guard.decide([other], 0, now, window_minutes=360)[0]


def test_main_prints_lines_for_github_output(monkeypatch, capsys):
    runs = [run(301, "2026-11-07 06:30:00", 700)]
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(runs)))
    assert guard.main(["--self-id", "302", "--now", "2026-11-07T07:10:00Z"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[0] == "go=false"
    assert lines[1].startswith("reason=") and "301" in lines[1]


def test_main_goes_on_an_empty_list(monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO("[]"))
    assert guard.main(["--self-id", "1"]) == 0
    assert capsys.readouterr().out.splitlines()[0] == "go=true"
