import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureRun, slotStart } from "./schedule.ts";

const env = { GITHUB_TOKEN: "t", REPO: "o/r", WORKFLOW: "news_scheduler.yml", REF: "main" };
const at = (iso: string) => new Date(iso);

type Run = { status: string; created_at: string; updated_at: string };
const realRun: Run = { status: "completed", created_at: "2026-11-03T07:07:05Z", updated_at: "2026-11-03T07:19:00Z" };

function fakeGitHub(runs: number | Run[], dispatchStatus = 204) {
  const list = typeof runs === "number" ? Array.from({ length: runs }, () => realRun) : runs;
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/runs?")) return new Response(JSON.stringify({ total_count: list.length, workflow_runs: list }), { status: 200 });
    return new Response(dispatchStatus === 204 ? null : "nope", { status: dispatchStatus });
  };
  return { calls, fetcher };
}

test("each check covers the latest slot at or before it", () => {
  assert.equal(slotStart(at("2026-11-03T07:07:00Z")).toISOString(), "2026-11-03T07:00:00.000Z");
  assert.equal(slotStart(at("2026-11-03T13:40:00Z")).toISOString(), "2026-11-03T13:00:00.000Z");
  assert.equal(slotStart(at("2026-11-03T23:40:00Z")).toISOString(), "2026-11-03T23:00:00.000Z");
  assert.equal(slotStart(at("2026-11-03T02:00:00Z")).toISOString(), "2026-11-02T23:00:00.000Z");
});

test("the morning slot starts the email edition", async () => {
  const gh = fakeGitHub(0);
  const out = await ensureRun(env, at("2026-11-03T07:07:00Z"), gh.fetcher);
  assert.deepEqual(out, { action: "started", slot: "2026-11-03T07:00:00Z", email_edition: true });
  assert.match(gh.calls[0].url, /\/repos\/o\/r\/actions\/workflows\/news_scheduler\.yml\/runs\?per_page=20&created=%3E%3D2026-11-03T07%3A00%3A00Z$/);
  const body = JSON.parse(String(gh.calls[1].init?.body));
  assert.deepEqual(body, { ref: "main", inputs: { email_edition: "true" } });
  assert.equal(gh.calls[1].init?.method, "POST");
});

test("other slots start a plain run", async () => {
  const gh = fakeGitHub(0);
  const out = await ensureRun(env, at("2026-11-03T17:07:00Z"), gh.fetcher);
  assert.equal(out.email_edition, false);
  assert.equal(JSON.parse(String(gh.calls[1].init?.body)).inputs.email_edition, "false");
});

test("a slot that already has a run is left alone", async () => {
  const gh = fakeGitHub(1);
  const out = await ensureRun(env, at("2026-11-03T07:40:00Z"), gh.fetcher);
  assert.equal(out.action, "already_running");
  assert.equal(gh.calls.length, 1);
});

test("failures are reported, not hidden", async () => {
  assert.equal((await ensureRun({ ...env, GITHUB_TOKEN: "" }, at("2026-11-03T07:07:00Z"), fakeGitHub(0).fetcher)).action, "error");
  const out = await ensureRun(env, at("2026-11-03T07:07:00Z"), fakeGitHub(0, 403).fetcher);
  assert.equal(out.action, "error");
  assert.match(out.detail ?? "", /HTTP 403/);
});

test("a cron run that only skipped itself does not cover the slot", async () => {
  // GitHub's late 07:11 cron arrives at 13:05, sees the Worker's 07:07 run and skips in seconds.
  const skipped: Run = { status: "completed", created_at: "2026-11-03T13:05:00Z", updated_at: "2026-11-03T13:05:12Z" };
  const gh = fakeGitHub([skipped]);
  const out = await ensureRun(env, at("2026-11-03T13:07:00Z"), gh.fetcher);
  assert.equal(out.action, "started");
});

test("a run still queued or in progress covers the slot", async () => {
  const running: Run = { status: "in_progress", created_at: "2026-11-03T13:01:00Z", updated_at: "2026-11-03T13:01:10Z" };
  const out = await ensureRun(env, at("2026-11-03T13:07:00Z"), fakeGitHub([running]).fetcher);
  assert.equal(out.action, "already_running");
});
