import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestGet } from "./traffic.ts";
import { sqliteD1 } from "../../_lib/d1-fake.test.ts";
import type { Env } from "../../_lib/http.ts";

const SECRET = "s3cret-for-tests-0123456789";
const NOW = new Date("2026-11-07T07:30:00Z");
const get = (e: Env, secret = SECRET) =>
  onRequestGet(
    { request: new Request("https://auranews.pages.dev/api/stats/traffic", { headers: secret ? { Authorization: `Bearer ${secret}` } : {} }), env: e },
    NOW,
  );

function db() {
  const d = sqliteD1();
  const hit = d.raw.prepare("INSERT INTO hits (day, path, source, count) VALUES (?, ?, ?, ?)");
  hit.run("2026-11-07", "/", "", 10);
  hit.run("2026-11-07", "/brief/", "", 4);
  hit.run("2026-11-07", "/brief/", "brief-20261107-11218", 3);
  hit.run("2026-11-06", "/news/", "brief-20261106-11165", 2);
  hit.run("2026-11-06", "/brief/", "brief-20261106-11165", 5);
  hit.run("2026-10-08", "/", "", 1); // the 31st day back: outside the window
  hit.run("2026-10-01", "/old/", "brief-20261001-1", 9);
  d.raw.prepare("INSERT INTO sends (day, edition, started_at, finished_at, sent, failed) VALUES ('2026-11-06', '20261106-11165', 's', 'f', 40, 0)").run();
  return d;
}

test("needs the owner's secret and the database", async () => {
  assert.equal((await get({ DB: db(), BRIEF_SEND_SECRET: SECRET }, "")).status, 401);
  assert.equal((await get({ DB: db() })).status, 503);
  assert.equal((await get({ BRIEF_SEND_SECRET: SECRET })).status, 503);
});

test("daily totals, top pages and brief clicks per edition for the last 30 days", async () => {
  const body = await (await get({ DB: db(), BRIEF_SEND_SECRET: SECRET })).json();
  assert.equal(body.since, "2026-10-09");
  assert.deepEqual(body.days, [
    { day: "2026-11-06", views: 7 },
    { day: "2026-11-07", views: 17 },
  ]);
  assert.deepEqual(body.top_paths, [
    { path: "/brief/", views: 12 },
    { path: "/", views: 10 },
    { path: "/news/", views: 2 },
  ]);
  assert.deepEqual(body.brief, [
    { edition: "20261107-11218", clicks: 3, sent: null },
    { edition: "20261106-11165", clicks: 7, sent: 40 },
  ]);
});

test("GET only", async () => {
  const { onRequest } = await import("./traffic.ts");
  assert.equal(onRequest().status, 405);
});
