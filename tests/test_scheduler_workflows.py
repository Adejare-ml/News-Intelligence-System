"""The scheduler workflows are wired the way docs/CLOUDFLARE.md describes.

These read the workflow files, not GitHub: a typo in an `if:` silently turns
a step off, which is how the morning email stayed tied to one cron string.
"""
import os
import re

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
    assert job["needs"] == ["run-pipeline", "deploy-pages", "deploy-production"]
    assert job["permissions"] == {"issues": "write"}
    close = step(job, "Close the alert issues after a good run")
    assert close["continue-on-error"] is True
    assert "pipeline-missed" in close["run"] and "pipeline-failure" in close["run"]


def test_production_refreshes_wait_for_promotions():
    # Both publish cloudflare-pages. In different concurrency groups, a refresh
    # that read the `production` tag before a promotion moved it, and
    # published after the promotion, put the previous code back in production.
    promote = load("promote_production.yml")
    jobs = load("news_scheduler.yml")["jobs"]
    job = jobs["deploy-production"]
    assert promote["concurrency"] == {"group": "production-deploy", "cancel-in-progress": False}
    # A refresh that cancelled in progress would stop a promotion halfway.
    assert job["concurrency"] == promote["concurrency"]
    assert job["needs"] == "run-pipeline"
    assert job["permissions"] == {"contents": "write"}

    # The tag is read and the branch published inside that group, in that order.
    names = [s.get("name") for s in job["steps"]]
    build = step(job, "Build production (promoted code, this run's data)")
    assert build["id"] == "production"
    assert "refs/tags/production" in build["run"]
    assert "web/scripts/build-production.sh" in build["run"]
    publish = step(job, "Publish production (cloudflare-pages)")
    assert publish["with"]["branch"] == "cloudflare-pages"
    assert publish["with"]["folder"] == "out-production"
    assert publish["if"] == "steps.production.outputs.built == 'true'"
    assert names.index(build["name"]) < names.index(publish["name"])
    ref = step(job, "Checkout the commit run-pipeline just pushed")["with"]
    assert ref["fetch-depth"] == 0
    assert "needs.run-pipeline.outputs.data_sha" in ref["ref"]

    # No other scheduler job builds or publishes production.
    for name, other in jobs.items():
        if name == "deploy-production":
            continue
        for s in other["steps"]:
            assert s.get("with", {}).get("branch") != "cloudflare-pages", name
            assert "refs/tags/production" not in s.get("run", ""), name
            assert "build-production.sh" not in s.get("run", ""), name
    # gh-pages keeps its own newest-wins group, which cannot cancel production.
    assert jobs["deploy-pages"]["concurrency"] == {"group": "pages-deploy", "cancel-in-progress": True}


def test_the_morning_brief_is_sent_after_the_production_publish():
    # The send reads this job's out-production/ and waits for production to
    # serve its edition, so it must follow the publish in the same job.
    job = load("news_scheduler.yml")["jobs"]["deploy-production"]
    names = [s.get("name") for s in job["steps"]]
    send = step(job, "Email the Morning Brief to subscribers")
    assert "'11 7 * * *'" in send["if"] and "inputs.email_edition" in send["if"]
    assert "steps.production.outputs.built == 'true'" in send["if"]
    assert "out-production/brief/email/index.html" in send["run"]
    record = step(job, "Record the sent edition")
    assert "out-production/data/email_digest.json" in record["run"]
    assert (names.index("Publish production (cloudflare-pages)")
            < names.index(send["name"]) < names.index(record["name"]))


def _expressions(value):
    """Every string in a step (if, run, with, env), as one blob."""
    if isinstance(value, dict):
        return " ".join(_expressions(v) for v in value.values())
    if isinstance(value, list):
        return " ".join(_expressions(v) for v in value)
    return str(value)


@pytest.mark.parametrize("name", ["news_scheduler.yml", "promote_production.yml"])
def test_each_job_has_the_steps_and_jobs_it_reads(name):
    # A step moved to another job without the step (or job) whose output it
    # reads sees an empty value: an `if:` on it is then quietly false.
    for job_name, job in load(name)["jobs"].items():
        ids = {s["id"] for s in job["steps"] if "id" in s}
        needs = job.get("needs", [])
        needs = [needs] if isinstance(needs, str) else needs
        text = _expressions(job)
        for ref in re.findall(r"steps\.([A-Za-z0-9_-]+)\.", text):
            assert ref in ids, f"{name} {job_name}: no step id {ref!r}"
        for ref in re.findall(r"needs\.([A-Za-z0-9_-]+)\.", text):
            assert ref in needs, f"{name} {job_name}: does not need {ref!r}"
        if "out-production/" in text:
            assert "production" in ids or "build-production.sh" in text, job_name


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
