import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestPost as subscribe } from "./subscribe.ts";
import { onRequestGet as confirm } from "./confirm.ts";
import { onRequestGet as unsubscribe } from "./unsubscribe.ts";
import { onRequestGet as prefsGet, onRequestPost as prefsPost, preferencesForm } from "./preferences.ts";
import { addSubscriber, sqliteD1 } from "../_lib/d1-fake.test.ts";
import { subscriberStore } from "../_lib/subscribers.ts";
import type { Env } from "../_lib/http.ts";

const SITE = "https://auranews.pages.dev";
const T = (c: string) => c.repeat(48);

function post(path: string, body: unknown, form = false): Request {
  if (form) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(body as Record<string, string | string[]>)) {
      for (const one of [v].flat()) fd.append(k, one);
    }
    return new Request(`${SITE}${path}`, { method: "POST", body: fd });
  }
  return new Request(`${SITE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

const get = (path: string) => new Request(`${SITE}${path}`);

test("sign-up stores the chosen categories, region and frequency", async () => {
  const db = sqliteD1();
  const env: Env = { DB: db };
  const res = await subscribe({ request: post("/api/subscribe", { email: "Ada@Example.com", categories: ["sports", "business"], region: "both", frequency: "weekly" }), env });
  assert.equal(res.status, 200);
  const row = await subscriberStore(db).byEmail("ada@example.com");
  assert.deepEqual([row!.status, row!.categories, row!.region, row!.frequency], ["pending", ["business", "sports"], "both", "weekly"]);
});

test("a form post with repeated checkboxes works too", async () => {
  const db = sqliteD1();
  await subscribe({ request: post("/api/subscribe", { email: "f@x.co", categories: ["politics", "technology"], region: "global" }, true), env: { DB: db } });
  const row = await subscriberStore(db).byEmail("f@x.co");
  assert.deepEqual([row!.categories, row!.region], [["technology", "politics"], "global"]);
});

test("an old client sending only an email gets Business", async () => {
  const db = sqliteD1();
  await subscribe({ request: post("/api/subscribe", { email: "old@x.co" }), env: { DB: db } });
  assert.deepEqual((await subscriberStore(db).byEmail("old@x.co"))!.categories, ["business"]);
});

test("unknown categories are refused", async () => {
  const res = await subscribe({ request: post("/api/subscribe", { email: "a@x.co", categories: ["chess"] }), env: { DB: sqliteD1() } });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /at least one/);
});

test("a confirmed reader's choices cannot be changed by re-subscribing", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "c@x.co", token: T("c"), categories: "business,politics" });
  const res = await subscribe({ request: post("/api/subscribe", { email: "c@x.co", categories: ["sports"] }), env: { DB: db } });
  assert.equal(res.status, 200);
  assert.deepEqual((await subscriberStore(db).byEmail("c@x.co"))!.categories, ["business", "politics"]);
});

test("the honeypot answers ok and stores nothing", async () => {
  const db = sqliteD1();
  await subscribe({ request: post("/api/subscribe", { email: "bot@x.co", company_site: "spam" }), env: { DB: db } });
  assert.equal(await subscriberStore(db).byEmail("bot@x.co"), null);
});

test("confirm names what the reader chose and links to preferences", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "a@x.co", token: T("a"), status: "pending", categories: "sports", region: "global", frequency: "weekly" });
  const res = await confirm({ request: get(`/api/confirm?token=${T("a")}`), env: { DB: db } });
  const html = await res.text();
  assert.match(html, /every Monday/);
  assert.match(html, /Sports \(Global\), once a week/);
  assert.match(html, /\/api\/preferences\?token=a{48}/);
  assert.equal((await subscriberStore(db).byToken(T("a")))!.status, "confirmed");
});

test("preferences page is pre-filled and saves changes", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "a@x.co", token: T("a"), categories: "business,sports", region: "both" });
  const page = await (await prefsGet({ request: get(`/api/preferences?token=${T("a")}`), env: { DB: db } })).text();
  assert.match(page, /value="sports" checked/);
  assert.match(page, /value="both" checked/);
  assert.doesNotMatch(page, /a@x\.co/, "the address is never shown");

  const saved = await prefsPost({
    request: post(`/api/preferences?token=${T("a")}`, { categories: ["entertainment"], region: "nigeria", frequency: "weekly" }, true),
    env: { DB: db },
  });
  assert.equal(saved.status, 200);
  const row = (await subscriberStore(db).byToken(T("a")))!;
  assert.deepEqual([row.categories, row.region, row.frequency, row.paused], [["entertainment"], "nigeria", "weekly", false]);
});

test("preferences: nothing ticked is an error, pause is saved", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "a@x.co", token: T("a") });
  const bad = await prefsPost({ request: post(`/api/preferences?token=${T("a")}`, { region: "global" }, true), env: { DB: db } });
  assert.equal(bad.status, 400);
  await prefsPost({ request: post(`/api/preferences?token=${T("a")}`, { categories: "business", paused: "1" }, true), env: { DB: db } });
  assert.equal((await subscriberStore(db).byToken(T("a")))!.paused, true);
});

test("preferences refuse bad and unknown tokens, and unsubscribed readers", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "u@x.co", token: T("e"), status: "unsubscribed" });
  assert.equal((await prefsGet({ request: get("/api/preferences?token=nope"), env: { DB: db } })).status, 400);
  assert.equal((await prefsGet({ request: get(`/api/preferences?token=${T("b")}`), env: { DB: db } })).status, 404);
  assert.match(await (await prefsGet({ request: get(`/api/preferences?token=${T("e")}`), env: { DB: db } })).text(), /unsubscribed/);
});

test("preferencesForm escapes the token", () => {
  const html = preferencesForm('"><ScRiPt>x', { categories: ["business"], region: "nigeria", frequency: "daily" }, false);
  assert.ok(!html.toLowerCase().includes("<script"), "no raw script tag in any case");
  assert.ok(html.includes("&quot;&gt;&lt;ScRiPt&gt;x"), "the token is escaped");
});

test("unsubscribe still works", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "a@x.co", token: T("a") });
  await unsubscribe({ request: get(`/api/unsubscribe?token=${T("a")}`), env: { DB: db } });
  assert.equal((await subscriberStore(db).byToken(T("a")))!.status, "unsubscribed");
});

test("a pending sign-up keeps its owner's choices; its confirmation mail says so", async () => {
  const db = sqliteD1();
  const mails: { to: string[]; subject: string; html: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => { mails.push(JSON.parse(String(init?.body))); return new Response("{}"); }) as typeof fetch;
  try {
    const env: Env = { DB: db, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k", MAIL_FROM: "A <a@x.org>", RESEND_API_BASE: "https://r.test" };
    await subscribe({ request: post("/api/subscribe", { email: "p@x.co", categories: ["business", "sports"], frequency: "weekly" }), env });
    await subscribe({ request: post("/api/subscribe", { email: "p@x.co", categories: ["entertainment"] }), env });
    const row = (await subscriberStore(db).byEmail("p@x.co"))!;
    assert.deepEqual([row.categories, row.frequency], [["business", "sports"], "weekly"]);
    assert.match(mails[1].html, /Business and Sports \(Nigeria\), once a week/, "the second confirmation names the owner's choices");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("every address gets the same answer; a confirmed one gets an already-subscribed email", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "c@x.co", token: T("c"), categories: "politics" });
  const mails: { to: string[]; subject: string; html: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => { mails.push(JSON.parse(String(init?.body))); return new Response("{}"); }) as typeof fetch;
  try {
    const env: Env = { DB: db, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k", MAIL_FROM: "A <a@x.org>", RESEND_API_BASE: "https://r.test", SITE_URL: SITE };
    const known = await (await subscribe({ request: post("/api/subscribe", { email: "c@x.co" }), env })).text();
    const fresh = await (await subscribe({ request: post("/api/subscribe", { email: "n@x.co" }), env })).text();
    assert.equal(known, fresh);
    assert.match(mails[0].subject, /already/);
    assert.match(mails[0].html, new RegExp(`/api/preferences\\?token=${T("c")}`));
    assert.match(mails[1].subject, /Confirm/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the form with no boxes ticked is an error, not a Business sign-up", async () => {
  const db = sqliteD1();
  const res = await subscribe({ request: post("/api/subscribe", { email: "nojs@x.co", choices: "1", region: "nigeria" }, true), env: { DB: db } });
  assert.equal(res.status, 400);
  assert.equal(await subscriberStore(db).byEmail("nojs@x.co"), null);
});
