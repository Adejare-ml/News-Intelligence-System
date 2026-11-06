import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestGet, summarise, weekOf } from "./stats.ts";
import { addSubscriber, sqliteD1 } from "../_lib/d1-fake.test.ts";
import type { Env } from "../_lib/http.ts";

const SECRET = "s3cret-for-tests-0123456789";
const T = (c: string) => c.repeat(48);
const get = (e: Env, secret = SECRET) =>
  onRequestGet({ request: new Request("https://auranews.pages.dev/api/stats", { headers: secret ? { Authorization: `Bearer ${secret}` } : {} }), env: e });

function db() {
  const d = sqliteD1();
  addSubscriber(d, { email: "a@x.co", token: T("a"), created_at: "2026-11-02T10:00:00Z" });
  addSubscriber(d, { email: "b@x.co", token: T("b"), categories: "business,sports", region: "both", created_at: "2026-11-03T10:00:00Z" });
  addSubscriber(d, { email: "c@x.co", token: T("c"), categories: "sports,politics", region: "global", frequency: "weekly", created_at: "2026-10-28T10:00:00Z" });
  addSubscriber(d, { email: "d@x.co", token: T("d"), status: "pending", categories: "technology" });
  addSubscriber(d, { email: "e@x.co", token: T("e"), paused: 1 });
  addSubscriber(d, { email: "f@x.co", token: T("f"), status: "unsubscribed" });
  d.raw.prepare("INSERT INTO sends (day, edition, started_at, finished_at, sent, failed) VALUES ('2026-11-05', 'ed', 's', 'f', 3, 0)").run();
  return d;
}

test("needs the owner's secret", async () => {
  assert.equal((await get({ DB: db(), BRIEF_SEND_SECRET: SECRET }, "")).status, 401);
  assert.equal((await get({ DB: db() })).status, 503);
});

test("counts by status, category, region and frequency, never addresses", async () => {
  const res = await get({ DB: db(), BRIEF_SEND_SECRET: SECRET });
  const text = await res.text();
  assert.doesNotMatch(text, /@x\.co/);
  const body = JSON.parse(text);
  assert.equal(body.total, 6);
  assert.deepEqual(body.status, { pending: 1, confirmed: 4, unsubscribed: 1 });
  assert.equal(body.paused, 1);
  assert.equal(body.active.total, 3);
  assert.deepEqual(body.active.by_category, { business: 2, sports: 2, technology: 0, politics: 1, entertainment: 0 });
  assert.deepEqual(body.active.by_region, { nigeria: 0, global: 1, both: 1 });
  assert.deepEqual(body.active.by_frequency, { daily: 2, weekly: 1 });
  assert.equal(body.sends[0].sent, 3);
});

test("weekOf and weekly sign-ups", () => {
  assert.equal(weekOf("2026-11-06T10:00:00Z"), "2026-11-02");
  assert.equal(weekOf("2026-11-02T00:00:00Z"), "2026-11-02");
  assert.equal(weekOf("nonsense"), null);
  const out = summarise([
    { status: "confirmed", paused: false, created_at: "2026-11-03T00:00:00Z", prefs: { categories: ["business"], region: "nigeria", frequency: "daily" } },
    { status: "pending", paused: false, created_at: "2026-11-04T00:00:00Z", prefs: { categories: ["business"], region: "nigeria", frequency: "daily" } },
  ]);
  assert.deepEqual(out.signups_by_week, [{ week: "2026-11-02", count: 2 }]);
});
