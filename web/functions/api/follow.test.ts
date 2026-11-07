import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { onRequestPost as follow, onRequest as followOther } from "./follow.ts";
import { onRequestGet as unsubscribe } from "./unsubscribe.ts";
import { onRequestGet as confirmGet, onRequestPost as confirmPost } from "./follow-confirm.ts";
import { addSubscriber, sqliteD1 } from "../_lib/d1-fake.test.ts";
import { followStore, MAX_FOLLOWS } from "../_lib/follows.ts";
import type { Env } from "../_lib/http.ts";

const SITE = "https://auranews.pages.dev";
const T = (c: string) => c.repeat(48);
const INDEX = { companies: [{ slug: "dangote-cement-plc", name: "Dangote Cement Plc" }, { slug: "mtn-nigeria", name: "MTN Nigeria" }] };

type Mail = { to: string[]; subject: string; html: string; text: string };
let mails: Mail[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  mails = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    mails.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function env(): Env & { DB: ReturnType<typeof sqliteD1> } {
  const db = sqliteD1();
  addSubscriber(db, { email: "reader@x.co", token: T("a") });
  addSubscriber(db, { email: "pending@x.co", token: T("b"), status: "pending" });
  addSubscriber(db, { email: "gone@x.co", token: T("c"), status: "unsubscribed" });
  return {
    DB: db,
    ASSETS: { fetch: async (r: Request | string) => {
      const path = new URL(typeof r === "string" ? r : r.url).pathname;
      return path === "/brief/email/follow/index.json" ? new Response(JSON.stringify(INDEX)) : new Response("nope", { status: 404 });
    } },
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_test",
    MAIL_FROM: "AURA <brief@example.org>",
    SITE_URL: SITE,
    RESEND_API_BASE: "https://resend.test",
  };
}

const ask = (e: Env, body: Record<string, string>) =>
  follow({ request: new Request(`${SITE}/api/follow`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env: e });

test("a confirmed reader gets a one-click confirm link; nothing is followed yet", async () => {
  const e = env();
  const res = await ask(e, { email: "Reader@X.co", slug: "dangote-cement-plc" });
  assert.equal(res.status, 200);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ["reader@x.co"]);
  assert.match(mails[0].subject, /Dangote Cement Plc/);
  assert.ok(mails[0].html.includes(`${SITE}/api/follow-confirm?token=${T("a")}&amp;slug=dangote-cement-plc`));
  assert.ok(mails[0].text.includes(`${SITE}/api/follow-confirm?token=${T("a")}&slug=dangote-cement-plc`));
  assert.deepEqual(await followStore(e.DB).list(T("a")), [], "typing an address must not add a follow");
});

test("unknown, pending and unsubscribed addresses get the same answer and an invitation, never a token", async () => {
  const e = env();
  const known = await (await ask(e, { email: "reader@x.co", slug: "mtn-nigeria" })).json();
  for (const email of ["stranger@x.co", "pending@x.co", "gone@x.co"]) {
    const res = await ask(e, { email, slug: "mtn-nigeria" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), known, `${email} gets the same response as a subscriber`);
  }
  const invites = mails.slice(1);
  assert.equal(invites.length, 3);
  for (const m of invites) {
    assert.match(m.subject, /MTN Nigeria/);
    assert.match(m.html, /\/brief\/#subscribe/);
    assert.doesNotMatch(m.html + m.text, /token=/);
  }
});

test("one follow email per address every ten minutes, same answer either way", async () => {
  const e = env();
  const first = await (await ask(e, { email: "reader@x.co", slug: "mtn-nigeria" })).json();
  const second = await (await ask(e, { email: "reader@x.co", slug: "mtn-nigeria" })).json();
  assert.deepEqual(second, first);
  const other = await ask(e, { email: "reader@x.co", slug: "dangote-cement-plc" });
  assert.equal(other.status, 200, "another company is throttled too, without an error");
  assert.equal(mails.length, 1);
});

test("bad input: honeypot, address, unknown company, wrong method", async () => {
  const e = env();
  const bot = await ask(e, { email: "reader@x.co", slug: "mtn-nigeria", company_site: "spam" });
  assert.equal(bot.status, 200);
  assert.equal(mails.length, 0, "a filled honeypot sends nothing");
  assert.equal((await ask(e, { email: "nope", slug: "mtn-nigeria" })).status, 400);
  assert.equal((await ask(e, { email: "reader@x.co", slug: "a-person" })).status, 400);
  assert.equal(followOther().status, 405);
  assert.equal(mails.length, 0);
});

test("with no email provider, follows say they open soon and store nothing", async () => {
  const e = { ...env(), EMAIL_PROVIDER: undefined };
  const res = await ask(e, { email: "reader@x.co", slug: "mtn-nigeria" });
  assert.equal(res.status, 503);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM follow_requests").get()!.n, 0);
});

const confirmUrl = (token: string, slug: string) => `${SITE}/api/follow-confirm?token=${token}&slug=${slug}`;

test("the confirm link shows a button; only the POST adds the follow", async () => {
  const e = env();
  const page = await confirmGet({ request: new Request(confirmUrl(T("a"), "mtn-nigeria")), env: e });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<form method="post" action="\/api\/follow-confirm\?token=a{48}&amp;slug=mtn-nigeria">/);
  assert.match(html, /MTN Nigeria/);
  assert.deepEqual(await followStore(e.DB).list(T("a")), [], "GET never changes state");

  const done = await confirmPost({ request: new Request(confirmUrl(T("a"), "mtn-nigeria"), { method: "POST" }), env: e });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /You now follow MTN Nigeria/);
  assert.deepEqual(await followStore(e.DB).list(T("a")), ["mtn-nigeria"]);
  const again = await confirmPost({ request: new Request(confirmUrl(T("a"), "mtn-nigeria"), { method: "POST" }), env: e });
  assert.match(await again.text(), /already follow MTN Nigeria/);
});

test("confirm refuses bad links, unsubscribed readers, unknown companies and a full list", async () => {
  const e = env();
  const status = async (url: string) => (await confirmPost({ request: new Request(url, { method: "POST" }), env: e })).status;
  assert.equal(await status(confirmUrl("short", "mtn-nigeria")), 400);
  assert.equal(await status(confirmUrl(T("9"), "mtn-nigeria")), 404);
  assert.equal(await status(confirmUrl(T("c"), "mtn-nigeria")), 404);
  assert.equal(await status(confirmUrl(T("a"), "not-a-company")), 404);
  assert.equal((await confirmGet({ request: new Request(confirmUrl(T("c"), "mtn-nigeria")), env: e })).status, 404);
  const store = followStore(e.DB);
  for (let i = 0; i < MAX_FOLLOWS; i++) await store.add(T("a"), `co-${i}`, "2026-11-06T07:00:00Z");
  const full = await confirmPost({ request: new Request(confirmUrl(T("a"), "mtn-nigeria"), { method: "POST" }), env: e });
  assert.equal(full.status, 409);
  assert.match(await full.text(), new RegExp(`${MAX_FOLLOWS} companies`));
});

test("without JavaScript the form gets a readable page, not raw JSON", async () => {
  const e = env();
  const form = (fields: Record<string, string>) =>
    follow({ request: new Request(`${SITE}/api/follow`, { method: "POST", body: new URLSearchParams(fields) }), env: e });
  const ok = await form({ email: "reader@x.co", slug: "mtn-nigeria", company_site: "" });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("Content-Type") ?? "", /text\/html/);
  assert.match(await ok.text(), /Check your inbox.*MTN Nigeria/);
  const bad = await form({ email: "nope", slug: "mtn-nigeria", company_site: "" });
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get("Content-Type") ?? "", /text\/html/);
  assert.match(await bad.text(), /doesn’t look right/);
});

test("unsubscribing deletes follows, so signing up again starts with none", async () => {
  const e = env();
  await followStore(e.DB).add(T("a"), "mtn-nigeria", "2026-11-06T07:00:00Z");
  await unsubscribe({ request: new Request(`${SITE}/api/unsubscribe?token=${T("a")}`), env: e });
  assert.deepEqual(await followStore(e.DB).list(T("a")), []);
});

test("unsubscribe still works before migration 0007 is applied", async () => {
  const e = env();
  e.DB.raw.exec("DROP TABLE follows");
  const res = await unsubscribe({ request: new Request(`${SITE}/api/unsubscribe?token=${T("a")}`), env: e });
  assert.equal(res.status, 200);
  assert.equal(e.DB.raw.prepare("SELECT status FROM subscribers WHERE token = ?").get(T("a"))!.status, "unsubscribed");
});
