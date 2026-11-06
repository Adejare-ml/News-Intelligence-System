import { test } from "node:test";
import assert from "node:assert/strict";
import { subscriberStore, sendLog } from "./subscribers.ts";
import { addSubscriber, sqliteD1 } from "./d1-fake.test.ts";

const T = (c: string) => c.repeat(48);

test("create, find, confirm and unsubscribe", async () => {
  const db = sqliteD1();
  const store = subscriberStore(db);
  await store.create("a@x.co", T("a"), { categories: ["sports", "politics"], region: "both", frequency: "weekly" }, "2026-11-06T07:00:00Z");
  const row = await store.byEmail("a@x.co");
  assert.deepEqual(row, {
    email: "a@x.co", token: T("a"), status: "pending", paused: false,
    categories: ["sports", "politics"], region: "both", frequency: "weekly",
  });
  await store.confirm(T("a"), "2026-11-06T08:00:00Z");
  assert.equal((await store.byToken(T("a")))!.status, "confirmed");
  await store.unsubscribe(T("a"), "2026-11-07T08:00:00Z");
  assert.equal((await store.byToken(T("a")))!.status, "unsubscribed");
});

test("legacy rows read as business, Nigeria, daily", async () => {
  const db = sqliteD1();
  db.raw.prepare("INSERT INTO subscribers (email, token, status, created_at) VALUES ('old@x.co', ?, 'confirmed', 'x')").run(T("o"));
  const row = await subscriberStore(db).byEmail("old@x.co");
  assert.deepEqual([row!.categories, row!.region, row!.frequency, row!.paused], [["business"], "nigeria", "daily", false]);
});

test("reopen only touches unsubscribed rows", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "c@x.co", token: T("c"), status: "confirmed" });
  addSubscriber(db, { email: "u@x.co", token: T("u"), status: "unsubscribed", paused: 1 });
  const store = subscriberStore(db);
  const prefs = { categories: ["sports" as const], region: "global" as const, frequency: "daily" as const };
  addSubscriber(db, { email: "p@x.co", token: T("d"), status: "pending" });
  await store.reopen("c@x.co", prefs);
  await store.reopen("u@x.co", prefs);
  await store.reopen("p@x.co", prefs);
  assert.deepEqual((await store.byEmail("c@x.co"))!.categories, ["business"]);
  assert.deepEqual((await store.byEmail("p@x.co"))!.categories, ["business"], "a pending row keeps its owner's choices");
  const u = (await store.byEmail("u@x.co"))!;
  assert.deepEqual([u.status, u.categories, u.paused], ["pending", ["sports"], false]);
});

test("recipients are confirmed and not paused", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "a@x.co", token: T("a") });
  addSubscriber(db, { email: "b@x.co", token: T("b"), status: "pending" });
  addSubscriber(db, { email: "p@x.co", token: T("p"), paused: 1 });
  addSubscriber(db, { email: "z@x.co", token: T("z"), categories: "sports,technology", region: "global" });
  const list = await subscriberStore(db).recipients();
  assert.deepEqual(list.map((s) => s.email), ["a@x.co", "z@x.co"]);
  assert.deepEqual(list[1].categories, ["sports", "technology"]);
});

test("updatePrefs saves topics and pause", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "a@x.co", token: T("a") });
  const store = subscriberStore(db);
  await store.updatePrefs(T("a"), { categories: ["entertainment"], region: "nigeria", frequency: "weekly" }, true);
  const a = (await store.byEmail("a@x.co"))!;
  assert.deepEqual([a.categories, a.frequency, a.paused], [["entertainment"], "weekly", true]);
});

test("send log", async () => {
  const log = sendLog(sqliteD1());
  assert.equal(await log.forDay("2026-11-06"), null);
  await log.start("2026-11-06", "ed1", "t0");
  assert.equal(await log.sentOn("ed1"), null);
  await log.finish("2026-11-06", 3, 1, "t1");
  assert.equal(await log.sentOn("ed1"), "2026-11-06");
  const row = (await log.forDay("2026-11-06"))!;
  assert.deepEqual([row.sent, row.failed, row.finished_at], [3, 1, "t1"]);
  assert.equal((await log.recent(5)).length, 1);
});
