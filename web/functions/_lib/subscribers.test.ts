import { test } from "node:test";
import assert from "node:assert/strict";
import { subscriberStore, sendLog, throttle } from "./subscribers.ts";
import { addSubscriber, sqliteD1 } from "./d1-fake.test.ts";

const T = (c: string) => c.repeat(48);

test("create, find, confirm and unsubscribe", async () => {
  const db = sqliteD1();
  const store = subscriberStore(db);
  await store.create("a@x.co", T("a"), { categories: ["technology", "politics"], region: "both", frequency: "weekly" }, "2026-11-06T07:00:00Z");
  const row = await store.byEmail("a@x.co");
  assert.deepEqual(row, {
    email: "a@x.co", token: T("a"), status: "pending", paused: false,
    categories: ["technology", "politics"], region: "both", frequency: "weekly",
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
  const prefs = { categories: ["technology" as const], region: "global" as const, frequency: "daily" as const };
  addSubscriber(db, { email: "p@x.co", token: T("d"), status: "pending" });
  await store.reopen("c@x.co", prefs);
  await store.reopen("u@x.co", prefs);
  await store.reopen("p@x.co", prefs);
  assert.deepEqual((await store.byEmail("c@x.co"))!.categories, ["business"]);
  assert.deepEqual((await store.byEmail("p@x.co"))!.categories, ["business"], "a pending row keeps its owner's choices");
  const u = (await store.byEmail("u@x.co"))!;
  assert.deepEqual([u.status, u.categories, u.paused], ["pending", ["technology"], false]);
});

test("recipients are confirmed and not paused", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "a@x.co", token: T("a") });
  addSubscriber(db, { email: "b@x.co", token: T("b"), status: "pending" });
  addSubscriber(db, { email: "p@x.co", token: T("p"), paused: 1 });
  addSubscriber(db, { email: "z@x.co", token: T("z"), categories: "politics,technology", region: "global" });
  const list = await subscriberStore(db).recipients();
  assert.deepEqual(list.map((s) => s.email), ["a@x.co", "z@x.co"]);
  assert.deepEqual(list[1].categories, ["technology", "politics"]);
});

test("updatePrefs saves topics and pause", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "a@x.co", token: T("a") });
  const store = subscriberStore(db);
  await store.updatePrefs(T("a"), { categories: ["politics"], region: "nigeria", frequency: "weekly" }, true);
  const a = (await store.byEmail("a@x.co"))!;
  assert.deepEqual([a.categories, a.frequency, a.paused], [["politics"], "weekly", true]);
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

test("claimMail allows one mail per 10 minutes and three per Lagos day", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "a@x.co", token: T("a"), status: "pending" });
  const store = subscriberStore(db);
  const at = (hhmm: string) => `2026-11-06T${hhmm}:00.000Z`;
  assert.equal(await store.claimMail("a@x.co", at("08:00"), "2026-11-06"), true);
  assert.equal(await store.claimMail("a@x.co", at("08:05"), "2026-11-06"), false, "too soon");
  assert.equal(await store.claimMail("a@x.co", at("08:10"), "2026-11-06"), true);
  assert.equal(await store.claimMail("a@x.co", at("09:00"), "2026-11-06"), true);
  assert.equal(await store.claimMail("a@x.co", at("10:00"), "2026-11-06"), false, "three today already");
  assert.equal(await store.claimMail("a@x.co", at("23:30"), "2026-11-07"), true, "a new Lagos day starts again");
  assert.equal(await store.claimMail("nobody@x.co", at("08:00"), "2026-11-06"), false);
});

test("releaseMail gives back a claim whose mail was never sent", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "a@x.co", token: T("a"), status: "pending" });
  const store = subscriberStore(db);
  await store.claimMail("a@x.co", "2026-11-06T08:00:00.000Z", "2026-11-06");
  await store.releaseMail("a@x.co", "2026-11-06T08:00:00.000Z", "2026-11-06");
  assert.equal(await store.claimMail("a@x.co", "2026-11-06T08:01:00.000Z", "2026-11-06"), true);
  const row = db.raw.prepare("SELECT mails_today FROM subscribers WHERE email = 'a@x.co'").get() as { mails_today: number };
  assert.equal(row.mails_today, 1);
});

test("a released claim still counts as a recent try, so housekeeping keeps the row", async () => {
  const db = sqliteD1();
  // Signed up 60 days ago; tries again today and the provider refuses the mail.
  addSubscriber(db, { email: "a@x.co", token: T("a"), status: "pending", created_at: "2026-09-07T08:00:00.000Z" });
  const store = subscriberStore(db);
  const now = "2026-11-06T08:00:00.000Z";
  await store.claimMail("a@x.co", now, "2026-11-06");
  await store.releaseMail("a@x.co", now, "2026-11-06");
  assert.equal(await store.claimMail("a@x.co", "2026-11-06T08:00:30.000Z", "2026-11-06"), true, "the reader can retry at once");
  await store.releaseMail("a@x.co", "2026-11-06T08:00:30.000Z", "2026-11-06");
  assert.equal(await store.deleteStalePending("2026-10-07T08:00:00.000Z"), 0);
});

test("throttle counts hits per key per day", async () => {
  const db = sqliteD1();
  const t = throttle(db);
  assert.equal(await t.hit("ip:1.2.3.4", "2026-11-06"), 1);
  assert.equal(await t.hit("ip:1.2.3.4", "2026-11-06"), 2);
  assert.equal(await t.hit("ip:5.6.7.8", "2026-11-06"), 1);
  assert.equal(await t.hit("ip:1.2.3.4", "2026-11-07"), 1, "a new day starts from one");
  await t.prune("2026-11-07");
  const keys = db.raw.prepare("SELECT key FROM throttle").all() as { key: string }[];
  assert.deepEqual(keys.map((k) => k.key), ["ip:1.2.3.4"], "earlier days are pruned");
});
