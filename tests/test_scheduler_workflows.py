"""The scheduler workflows are wired the way docs/CLOUDFLARE.md describes.

These read the workflow files, not GitHub: a typo in an `if:` silently turns
a step off, which is how the morning email stayed tied to one cron string.
"""
import os

import pytest

yaml = pytest.importorskip("yaml")

WORKFLOWS = os.path.join(os.path.dirname(__file__), "..", ".github", "workflows")


def load(name):
    with open(os.path.join(WORKFLOWS, name), encoding="utf-8") as f:
        return yaml.safe_load(f)


def step(job, name):
    for s in job["steps"]:
        if s.get("name") == name:
            return s
    raise AssertionError(f"no step named {name!r}")


def test_the_guard_uses_scheduler_guard_and_lets_manual_runs_through():
    guard = load("news_scheduler.yml")["jobs"]["guard"]
    run = step(guard, "Skip a scheduled run when another run just did the work")["run"]
    assert "scripts/scheduler_guard.py" in run
    assert '"$EVENT" != "schedule"' in run


def test_the_owner_email_also_goes_out_for_a_manual_email_edition():
    job = load("news_scheduler.yml")["jobs"]["run-pipeline"]
    cond = step(job, "Send the morning email briefing")["if"]
    assert "'11 7 * * *'" in cond and "inputs.email_edition" in cond
