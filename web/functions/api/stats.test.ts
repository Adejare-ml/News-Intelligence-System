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
  addSubscriber(d, { email: "b@x.co", token: T("b"), categories: "business,technology", region: "both", created_at: "2026-11-03T10:00:00Z" });
  addSubscriber(d, { email: "c@x.co", token: T("c"), categories: "technology,politics", region: "global", frequency: "weekly", created_at: "2026-10-28T10:00:00Z" });
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
  assert.deepEqual(body.active.by_category, { business: 2, technology: 2, politics: 1 });
  assert.deepEqual(body.active.by_region, { nigeria: 0, global: 1, both: 1 });
  assert.deepEqual(body.active.by_frequency, { daily: 2, weekly: 1 });
  assert.equal(body.sends[0].sent, 3);
});

test("weekOf and weekly sign-ups", () => {
  assert.equal(weekOf("2026-11-06T10:00:00Z"), "2026-11-02");
  assert.equal(weekOf("2026-11-02T00:00:00Z"), "2026-11-02");
  assert.equal(weekOf("nonsense"), null);
  const out = summarise([
    { status: "confirmed", paused: false, created_at: "2026-11-03T00:00:00Z", confirmed_at: null, prefs: { categories: ["business"], region: "nigeria", frequency: "daily" } },
    { status: "pending", paused: false, created_at: "2026-11-04T00:00:00Z", confirmed_at: null, prefs: { categories: ["business"], region: "nigeria", frequency: "daily" } },
  ]);
  assert.deepEqual(out.signups_by_week, [{ week: "2026-11-02", count: 2 }]);
});

test("confirmation rate and median hours to confirm", () => {
  const prefs = { categories: ["business" as const], region: "nigeria" as const, frequency: "daily" as const };
  const row = (status: string, created_at: string, confirmed_at: string | null = null) => ({ status, paused: false, created_at, confirmed_at, prefs });
  const now = new Date("2026-11-10T12:00:00Z");
  const out = summarise(
    [
      row("confirmed", "2026-11-01T10:00:00Z", "2026-11-01T11:00:00Z"), // 1 hour
      row("unsubscribed", "2026-11-02T10:00:00Z", "2026-11-02T13:00:00Z"), // 3 hours, then left
      row("confirmed", "2026-11-03T10:00:00Z", "2026-11-05T10:00:00Z"), // 48 hours
      row("unsubscribed", "2026-11-04T10:00:00Z"), // removed from the confirmation mail: never confirmed
      row("pending", "2026-11-05T10:00:00Z"), // past the 72-hour wait: counts as not confirmed
      row("pending", "2026-11-09T10:00:00Z"), // still within 72 hours: not counted yet
    ],
    12,
    now,
  );
  assert.equal(out.confirmation.rate, 0.6, "3 confirmed of the 5 sign-ups that have had 72 hours");
  assert.equal(out.confirmation.counted, 5);
  assert.equal(out.confirmation.median_hours_to_confirm, 3);
  const none = summarise([row("pending", "2026-11-10T10:00:00Z")], 12, now);
  assert.deepEqual(none.confirmation, { rate: null, counted: 0, median_hours_to_confirm: null });
});

test("the stats endpoint reads confirmation times from D1", async () => {
  const d = sqliteD1();
  addSubscriber(d, { email: "a@x.co", token: T("a"), created_at: "2026-11-01T10:00:00Z" });
  addSubscriber(d, { email: "b@x.co", token: T("b"), created_at: "2026-11-01T10:00:00Z" });
  d.raw.prepare("UPDATE subscribers SET confirmed_at = '2026-11-01T12:00:00Z' WHERE email = 'a@x.co'").run();
  d.raw.prepare("UPDATE subscribers SET confirmed_at = '2026-11-01T16:00:00Z' WHERE email = 'b@x.co'").run();
  const body = await (await get({ DB: d, BRIEF_SEND_SECRET: SECRET })).json();
  assert.equal(body.confirmation.median_hours_to_confirm, 4);
  assert.equal(body.confirmation.rate, 1);
});
