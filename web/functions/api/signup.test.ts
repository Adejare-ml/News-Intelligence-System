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

/** Moves an address's last mail an hour back, as if the 10-minute gap had passed. */
function rewindMail(db: ReturnType<typeof sqliteD1>, email: string): void {
  db.raw.prepare("UPDATE subscribers SET last_mailed_at = ? WHERE email = ?").run(new Date(Date.now() - 3_600_000).toISOString(), email);
}

const RESEND: Env = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k", MAIL_FROM: "A <a@x.org>", RESEND_API_BASE: "https://r.test", SITE_URL: SITE };

/** Runs `fn` with the provider stubbed: every mail sent is recorded and answered with `status`. */
async function withMail(fn: (mails: { to: string[]; subject: string }[]) => Promise<void>, status = 200): Promise<void> {
  const mails: { to: string[]; subject: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    mails.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status });
  }) as typeof fetch;
  try {
    await fn(mails);
  } finally {
    globalThis.fetch = realFetch;
  }
}

function fromIp(ip: string, email: string): Request {
  return new Request(`${SITE}/api/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ email }),
  });
}

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
    rewindMail(db, "p@x.co");
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

test("a paused reader's already-subscribed email says it is paused", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "z@x.co", token: T("f"), paused: 1 });
  const mails: { subject: string; html: string; text: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => { mails.push(JSON.parse(String(init?.body))); return new Response("{}"); }) as typeof fetch;
  try {
    const env: Env = { DB: db, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k", MAIL_FROM: "A <a@x.org>", RESEND_API_BASE: "https://r.test", SITE_URL: SITE };
    await subscribe({ request: post("/api/subscribe", { email: "z@x.co", categories: ["sports"], choices: "1" }), env });
    assert.match(mails[0].html, /paused for now/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the category alias still works alongside the form marker", async () => {
  const db = sqliteD1();
  const res = await subscribe({ request: post("/api/subscribe", { email: "e@x.co", choices: "1", category: "sports" }), env: { DB: db } });
  assert.equal(res.status, 200);
  assert.deepEqual((await subscriberStore(db).byEmail("e@x.co"))!.categories, ["sports"]);
});

test("a second sign-up within 10 minutes sends nothing but answers the same", async () => {
  const db = sqliteD1();
  await withMail(async (mails) => {
    const env: Env = { DB: db, ...RESEND };
    const first = await subscribe({ request: post("/api/subscribe", { email: "t@x.co" }), env });
    const second = await subscribe({ request: post("/api/subscribe", { email: "t@x.co" }), env });
    assert.equal(mails.length, 1);
    assert.equal(second.status, 200);
    assert.equal(await second.text(), await first.text());
  });
});

test("an address gets at most three sign-up mails a Lagos day", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "c@x.co", token: T("c") });
  await withMail(async (mails) => {
    const env: Env = { DB: db, ...RESEND };
    for (let i = 0; i < 5; i++) {
      rewindMail(db, "c@x.co");
      assert.equal((await subscribe({ request: post("/api/subscribe", { email: "c@x.co" }), env })).status, 200);
    }
    assert.equal(mails.length, 3);
  });
});

test("one IP gets 20 sign-up posts a day, then a 429", async () => {
  const db = sqliteD1();
  const env: Env = { DB: db };
  for (let i = 0; i < 20; i++) {
    assert.equal((await subscribe({ request: fromIp("203.0.113.9", `r${i}@x.co`), env })).status, 200);
  }
  const over = await subscribe({ request: fromIp("203.0.113.9", "late@x.co"), env });
  assert.equal(over.status, 429);
  assert.equal(((await over.json()) as { error: string }).error, "Too many sign-ups from here today. Try again tomorrow.");
  assert.equal(await subscriberStore(db).byEmail("late@x.co"), null);
  assert.equal((await subscribe({ request: fromIp("198.51.100.1", "other@x.co"), env })).status, 200, "other IPs are unaffected");
  assert.equal((await subscribe({ request: post("/api/subscribe", { email: "noip@x.co" }), env })).status, 200, "no IP header, no IP limit");
});

test("a provider failure is a 502 for every address, and the try is given back", async () => {
  const db = sqliteD1();
  addSubscriber(db, { email: "c@x.co", token: T("c") });
  const env: Env = { DB: db, ...RESEND };
  const bodies: string[] = [];
  await withMail(async () => {
    for (const email of ["c@x.co", "new@x.co"]) {
      const res = await subscribe({ request: post("/api/subscribe", { email }), env });
      assert.equal(res.status, 502);
      bodies.push(await res.text());
    }
  }, 500);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[0]).error, "We couldn't send the email just now. Please try again in a few minutes.");
  await withMail(async (mails) => {
    await subscribe({ request: post("/api/subscribe", { email: "new@x.co" }), env });
    assert.equal(mails.length, 1, "a retry straight after the failure is sent");
  });
});
