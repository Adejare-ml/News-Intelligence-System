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
    # The slot lets a late cron skip when the Worker already ran its slot.
    assert '--slot "$SCHEDULE"' in run
    env = step(guard, "Skip a scheduled run when another run just did the work")["env"]
    assert env["SCHEDULE"] == "${{ github.event.schedule }}"


def test_the_owner_email_also_goes_out_for_a_manual_email_edition():
    job = load("news_scheduler.yml")["jobs"]["run-pipeline"]
    cond = step(job, "Send the morning email briefing")["if"]
    assert "'11 7 * * *'" in cond and "inputs.email_edition" in cond


def test_alerts_close_only_after_the_site_and_brief_are_published():
    jobs = load("news_scheduler.yml")["jobs"]
    # Closing in run-pipeline closed them before deploy-pages had published
    # anything, and a gh error there skipped deploy-pages altogether.
    assert not any("pipeline-missed" in s.get("run", "") for s in jobs["run-pipeline"]["steps"])
    job = jobs["close-alerts"]
    assert job["needs"] == ["run-pipeline", "deploy-pages"]
    assert job["permissions"] == {"issues": "write"}
    close = step(job, "Close the alert issues after a good run")
    assert close["continue-on-error"] is True
    assert "pipeline-missed" in close["run"] and "pipeline-failure" in close["run"]


def test_the_watchdog_raises_a_missed_slot_issue():
    wf = load("scheduler_watchdog.yml")
    assert wf["permissions"]["issues"] == "write"
    run = step(wf["jobs"]["check"], "Raise an issue when nothing has run for six hours")["run"]
    assert "--window-minutes 360" in run
    assert "gh label create pipeline-missed" in run and "|| true" in run


def test_the_scheduler_worker_deploys_from_github():
    wf = load("deploy_scheduler.yml")
    # PyYAML reads the bare key `on` as True.
    on = wf.get("on", wf.get(True))
    assert "workflow_dispatch" in on
    assert on["push"]["branches"] == ["main"]
    assert on["push"]["paths"] == ["web/workers/scheduler/**"]
    assert wf["permissions"] == {"contents": "read"}
    steps = wf["jobs"]["deploy"]["steps"]
    deploy = next(s for s in steps if "wrangler@4 deploy" in s.get("run", ""))
    assert deploy["working-directory"] == "web/workers/scheduler"
    assert any("wrangler@4 secret put GITHUB_TOKEN" in s.get("run", "") for s in steps)
