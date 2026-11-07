import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestGet, onRequestPost } from "./hit.ts";
import { sqliteD1 } from "../_lib/d1-fake.test.ts";

const ORIGIN = "https://auranews.pages.dev";
const UA = "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0";
const NOW = new Date("2026-11-07T07:30:00Z");
type DB = ReturnType<typeof sqliteD1>;

const beacon = (db: DB, body: unknown, headers: Record<string, string> = {}) =>
  onRequestPost(
    {
      request: new Request(`${ORIGIN}/api/hit`, {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { "User-Agent": UA, ...headers },
      }),
      env: { DB: db },
    },
    NOW,
  );
const click = (db: DB, query: string, headers: Record<string, string> = {}) =>
  onRequestGet({ request: new Request(`${ORIGIN}/api/hit?${query}`, { headers: { "User-Agent": UA, ...headers } }), env: { DB: db } }, NOW);
const rows = (db: DB) =>
  db.raw.prepare("SELECT day, path, source, count FROM hits ORDER BY path, source").all().map((r) => ({ ...r }));

test("counts page views as daily aggregates, keyed by Lagos day, path and source", async () => {
  const db = sqliteD1();
  assert.equal((await beacon(db, { p: "/brief/" })).status, 204);
  await beacon(db, { p: "/brief/" });
  await beacon(db, { p: "/brief/", s: "brief-20261107-11218" });
  assert.deepEqual(rows(db), [
    { day: "2026-11-07", path: "/brief/", source: "", count: 2 },
    { day: "2026-11-07", path: "/brief/", source: "brief-20261107-11218", count: 1 },
  ]);
});

test("stores nothing that identifies a reader", async () => {
  const db = sqliteD1();
  await beacon(db, { p: "/", ip: "1.2.3.4" }, { "CF-Connecting-IP": "1.2.3.4", Cookie: "id=abc" });
  const columns = db.raw.prepare("PRAGMA table_info(hits)").all().map((c) => (c as { name: string }).name);
  assert.deepEqual(columns, ["day", "path", "source", "count"]);
  assert.equal(rows(db).length, 1);
  assert.doesNotMatch(JSON.stringify(rows(db)), /1\.2\.3\.4|abc|Mozilla/);
});

test("drops the query string and rejects bad paths and sources", async () => {
  const db = sqliteD1();
  await beacon(db, { p: "/news/?q=dangote#top" });
  assert.equal((await beacon(db, { p: "news/" })).status, 400);
  assert.equal((await beacon(db, { p: `/${"a".repeat(200)}` })).status, 400);
  assert.equal((await beacon(db, { p: "/", s: "Brief_1" })).status, 400);
  assert.equal((await beacon(db, { p: "/", s: "a".repeat(41) })).status, 400);
  assert.equal((await beacon(db, "not json")).status, 400);
  assert.deepEqual(rows(db).map((r) => r.path), ["/news/"]);
});

test("does not count bots, or readers who ask not to be tracked", async () => {
  const db = sqliteD1();
  for (const ua of ["Googlebot/2.1", "SomeCrawler", "Baiduspider"]) {
    assert.equal((await beacon(db, { p: "/" }, { "User-Agent": ua })).status, 204);
  }
  await beacon(db, { p: "/" }, { "Sec-GPC": "1" });
  await beacon(db, { p: "/" }, { DNT: "1" });
  assert.equal(rows(db).length, 0);
});

test("email click: counts, then redirects only to the site's own pages", async () => {
  const db = sqliteD1();
  const ok = await click(db, `s=brief-20261107-11218&to=${encodeURIComponent(`${ORIGIN}/brief/?x=1`)}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("Location"), `${ORIGIN}/brief/?x=1`);
  assert.deepEqual(rows(db), [{ day: "2026-11-07", path: "/brief/", source: "brief-20261107-11218", count: 1 }]);

  for (const to of ["https://evil.example/", "//evil.example/", "javascript:alert(1)", "https://auranews.pages.dev.evil.example/", "/brief/"]) {
    assert.equal((await click(db, `to=${encodeURIComponent(to)}`)).status, 400, to);
  }
  assert.equal((await click(db, "")).status, 400);
  assert.equal(rows(db).length, 1);
});

test("email click: the site's configured address counts as its own origin", async () => {
  const db = sqliteD1();
  const res = await onRequestGet(
    { request: new Request(`${ORIGIN}/api/hit?to=${encodeURIComponent("https://aura.example.ng/news/")}`, { headers: { "User-Agent": UA } }), env: { DB: db, SITE_URL: "https://aura.example.ng" } },
    NOW,
  );
  assert.equal(res.status, 302);
});

test("email click: a bot still gets redirected but is not counted", async () => {
  const db = sqliteD1();
  const res = await click(db, `p=/news/&to=${encodeURIComponent(`${ORIGIN}/news/`)}`, { "User-Agent": "Slackbot-LinkExpanding" });
  assert.equal(res.status, 302);
  assert.equal(rows(db).length, 0);
});

test("email click: still redirects when the database is not bound", async () => {
  const res = await onRequestGet({ request: new Request(`${ORIGIN}/api/hit?to=${encodeURIComponent(`${ORIGIN}/`)}`), env: {} }, NOW);
  assert.equal(res.status, 302);
});
