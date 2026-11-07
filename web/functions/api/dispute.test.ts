import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestPost as dispute, onRequest, DISPUTE_RECEIVED } from "./dispute.ts";
import { sqliteD1 } from "../_lib/d1-fake.test.ts";
import type { Env } from "../_lib/http.ts";

const SITE = "https://auranews.pages.dev";
const GOOD = {
  name: "Tolu Bakare",
  email: "Tolu@Example.com",
  relationship: "subject",
  ref: "tolu-bakare",
  message: "I have never held shares in Ikeja Mills.",
};

function post(body: Record<string, string>, { form = false, ip = "203.0.113.7" } = {}): Request {
  const headers: Record<string, string> = { "CF-Connecting-IP": ip };
  if (form) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(body)) fd.append(k, v);
    return new Request(`${SITE}/api/dispute`, { method: "POST", body: fd, headers });
  }
  return new Request(`${SITE}/api/dispute`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const rows = (db: ReturnType<typeof sqliteD1>) => db.raw.prepare("SELECT * FROM disputes ORDER BY id").all() as Record<string, unknown>[];

test("a valid dispute is stored as open and answered with the standard message", async () => {
  const db = sqliteD1();
  const res = await dispute({ request: post(GOOD), env: { DB: db } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, message: DISPUTE_RECEIVED });
  const [row] = rows(db);
  assert.deepEqual(
    [row.ref, row.name, row.email, row.relationship, row.message, row.status],
    ["tolu-bakare", "Tolu Bakare", "tolu@example.com", "subject", GOOD.message, "open"],
  );
  assert.match(String(row.created_at), /^\d{4}-\d{2}-\d{2}T/);
});

test("each field is checked", async () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ ...GOOD, name: " " }, /name/i],
    [{ ...GOOD, email: "not-an-email" }, /email/i],
    [{ ...GOOD, relationship: "journalist" }, /relationship|who you are/i],
    [{ ...GOOD, ref: "" }, /record/i],
    [{ ...GOOD, message: "" }, /what is wrong/i],
    [{ ...GOOD, message: "x".repeat(4001) }, /4,000/],
  ];
  for (const [body, error] of cases) {
    const db = sqliteD1();
    const res = await dispute({ request: post(body), env: { DB: db } });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(((await res.json()) as { error: string }).error, error);
    assert.equal(rows(db).length, 0);
  }
});

test("a filled honeypot looks like success and stores nothing", async () => {
  const db = sqliteD1();
  const res = await dispute({ request: post({ ...GOOD, company_site: "spam.example" }), env: { DB: db } });
  assert.deepEqual(await res.json(), { ok: true, message: DISPUTE_RECEIVED });
  assert.equal(rows(db).length, 0);
});

test("one sender gets five disputes a day; the sixth is answered the same and not stored", async () => {
  const db = sqliteD1();
  for (let i = 0; i < 6; i++) {
    const res = await dispute({ request: post(GOOD), env: { DB: db } });
    assert.deepEqual(await res.json(), { ok: true, message: DISPUTE_RECEIVED });
  }
  assert.equal(rows(db).length, 5);
  // Another sender is not affected.
  await dispute({ request: post(GOOD, { ip: "198.51.100.2" }), env: { DB: db } });
  assert.equal(rows(db).length, 6);
  // The throttle never stores the IP address itself.
  const keys = db.raw.prepare("SELECT key FROM dispute_throttle").all() as { key: string }[];
  assert.ok(keys.every((k) => !k.key.includes("203.0.113.7") && !k.key.includes("198.51.100.2")));
});

test("the owner is emailed when sending is on, with the reader's text escaped", async () => {
  const sent: { to: string; subject: string; html: string; text: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ to: body.to[0], subject: body.subject, html: body.html, text: body.text });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const env: Env = {
      DB: sqliteD1(),
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_test",
      MAIL_FROM: "AURA <brief@example.org>",
      OWNER_EMAIL: "owner@example.org",
    };
    const res = await dispute({ request: post({ ...GOOD, message: "<script>x</script> wrong" }), env });
    assert.deepEqual(await res.json(), { ok: true, message: DISPUTE_RECEIVED });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "owner@example.org");
    assert.match(sent[0].subject, /tolu-bakare/);
    assert.doesNotMatch(sent[0].html, /<script>/);
    assert.match(sent[0].text, /<script>x<\/script> wrong/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a failed owner email still gives the reader the same answer", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    const db = sqliteD1();
    const env: Env = { DB: db, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test", MAIL_FROM: "a@b.co", OWNER_EMAIL: "o@b.co" };
    const res = await dispute({ request: post(GOOD), env });
    assert.deepEqual(await res.json(), { ok: true, message: DISPUTE_RECEIVED });
    assert.equal(rows(db).length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a form post without JavaScript gets a page, not JSON", async () => {
  const db = sqliteD1();
  const res = await dispute({ request: post(GOOD, { form: true }), env: { DB: db } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") || "", /text\/html/);
  assert.match(await res.text(), /Thank you/);
  assert.equal(rows(db).length, 1);

  const bad = await dispute({ request: post({ ...GOOD, email: "nope" }, { form: true }), env: { DB: db } });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /email/i);
});

test("without a database the form says it is not open yet", async () => {
  const res = await dispute({ request: post(GOOD), env: {} });
  assert.equal(res.status, 503);
});

test("only POST is accepted", () => {
  const res = onRequest();
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "POST");
});
