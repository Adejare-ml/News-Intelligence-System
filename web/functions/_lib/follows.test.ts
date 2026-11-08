import { test } from "node:test";
import assert from "node:assert/strict";
import { followStore, followRequests, loadFollowable, matchCompany, MAX_FOLLOWS, REQUEST_GAP_MINUTES } from "./follows.ts";
import { addSubscriber, sqliteD1 } from "./d1-fake.test.ts";
import type { Env } from "./http.ts";

const T = (c: string) => c.repeat(48);
const NOW = "2026-11-06T07:00:00.000Z";

test("follow, list in order, unfollow; following twice is one follow", async () => {
  const db = sqliteD1();
  const store = followStore(db);
  assert.equal(await store.add(T("a"), "dangote-cement-plc", NOW), "added");
  assert.equal(await store.add(T("a"), "access-holdings-plc", NOW), "added");
  assert.equal(await store.add(T("a"), "dangote-cement-plc", NOW), "already");
  assert.deepEqual(await store.list(T("a")), ["access-holdings-plc", "dangote-cement-plc"]);
  await store.remove(T("a"), "dangote-cement-plc");
  assert.deepEqual(await store.list(T("a")), ["access-holdings-plc"]);
});

test(`a reader can follow at most ${MAX_FOLLOWS} companies`, async () => {
  const db = sqliteD1();
  const store = followStore(db);
  for (let i = 0; i < MAX_FOLLOWS; i++) assert.equal(await store.add(T("a"), `co-${i}`, NOW), "added");
  assert.equal(await store.add(T("a"), "one-more", NOW), "full");
  assert.equal(await store.add(T("a"), "co-3", NOW), "already", "an existing follow is not refused as over the limit");
  assert.equal((await store.list(T("a"))).length, MAX_FOLLOWS);
});

test("follows for every confirmed, unpaused reader come back in one query", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "a@x.co", token: T("a") });
  addSubscriber(db, { email: "b@x.co", token: T("b") });
  addSubscriber(db, { email: "p@x.co", token: T("c"), paused: 1 });
  addSubscriber(db, { email: "u@x.co", token: T("d"), status: "unsubscribed" });
  const store = followStore(db);
  for (const t of [T("a"), T("c"), T("d")]) await store.add(t, "zenith-bank-plc", NOW);
  await store.add(T("a"), "access-holdings-plc", NOW);
  db.queries.length = 0;
  const all = await store.forRecipients();
  assert.equal(db.queries.length, 1);
  assert.deepEqual(Object.fromEntries(all), { [T("a")]: ["access-holdings-plc", "zenith-bank-plc"] });
});

test(`follow requests: one email per address every ${REQUEST_GAP_MINUTES} minutes, old rows pruned`, async () => {
  const db = sqliteD1();
  const req = followRequests(db);
  const at = (min: number) => new Date(Date.parse(NOW) + min * 60_000);
  assert.equal(await req.allow("a@x.co", at(0)), true);
  assert.equal(await req.allow("a@x.co", at(3)), false);
  assert.equal(await req.allow("b@x.co", at(3)), true, "the limit is per address");
  assert.equal(await req.allow("a@x.co", at(9)), false, "a refused try does not restart the clock, but does not slip through either");
  assert.equal(await req.allow("a@x.co", at(REQUEST_GAP_MINUTES + 1)), true);
  await req.allow("c@x.co", at(60 * 25));
  const rows = db.raw.prepare("SELECT email FROM follow_requests ORDER BY email").all() as { email: string }[];
  assert.deepEqual(rows.map((r) => r.email), ["c@x.co"], "addresses are kept no longer than a day");
});

const INDEX = { generated: NOW, companies: [{ slug: "dangote-cement-plc", name: "Dangote Cement Plc" }, { slug: "mtn-nigeria", name: "MTN Nigeria" }] };

function assetsEnv(body: unknown, status = 200): Env {
  return { ASSETS: { fetch: async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }) } };
}

test("the followable list comes from the built site", async () => {
  const list = await loadFollowable(assetsEnv(INDEX), "https://auranews.pages.dev");
  assert.equal(list.get("mtn-nigeria"), "MTN Nigeria");
  assert.equal(list.size, 2);
  assert.equal((await loadFollowable(assetsEnv("nope", 404), "https://x")).size, 0);
  assert.equal((await loadFollowable(assetsEnv("{bad json"), "https://x")).size, 0);
  assert.equal((await loadFollowable({}, "https://x")).size, 0);
});

test("a typed company matches by name or slug, nothing else", async () => {
  const list = await loadFollowable(assetsEnv(INDEX), "https://x");
  assert.equal(matchCompany("  dangote cement PLC ", list), "dangote-cement-plc");
  assert.equal(matchCompany("mtn-nigeria", list), "mtn-nigeria");
  assert.equal(matchCompany("Dangote", list), null);
  assert.equal(matchCompany("", list), null);
});
