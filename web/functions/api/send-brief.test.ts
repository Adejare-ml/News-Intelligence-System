import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { onRequestPost, sameSecret, lagosDay, readMeta, stripScripts } from "./send-brief.ts";
import { personalise, htmlToText, batchPayload, chunk, decodeEntities, parseFrom, smtpTransport, gmailFrom } from "../_lib/mailer.ts";
import { fakeSmtp } from "../_lib/smtp-fake.test.ts";
import { addSubscriber, sqliteD1 } from "../_lib/d1-fake.test.ts";
import type { Env } from "../_lib/http.ts";

const SECRET = "s3cret-for-tests-0123456789";
const TEMPLATE = `<!doctype html><html><head>
<meta name="aura-edition" content="20261022-074512" />
<meta name="aura-subject" content="AURA Morning Brief · Thursday 22 October" />
<script type="module" src="/_astro/page.abc.js"></script>
</head><body><p>Hello &amp; welcome</p><a href="https://auranews.pages.dev/brief/">Read the full brief</a>
<a href="{{unsubscribe_url}}">Unsubscribe</a></body></html>`;

/** The real schema in SQLite, plus a small handle on the sends table for setup and checks. */
function fakeDb(subscribers: { email: string; token: string; status: string; categories?: string; region?: string; frequency?: string; paused?: number }[]) {
  const db = sqliteD1();
  for (const s of subscribers) addSubscriber(db, s);
  const sends = {
    set(day: string, row: { edition: string; finished_at: string | null; sent: number; failed: number }) {
      db.raw.prepare("INSERT INTO sends (day, edition, started_at, finished_at, sent, failed) VALUES (?, ?, ?, ?, ?, ?)")
        .run(day, row.edition, row.finished_at ?? "", row.finished_at, row.sent, row.failed);
    },
    get size() {
      return Number((db.raw.prepare("SELECT COUNT(*) AS n FROM sends").get() as { n: number }).n);
    },
  };
  return Object.assign(db, { sends });
}

const subs = [
  { email: "a@example.com", token: "a".repeat(48), status: "confirmed" },
  { email: "b@example.com", token: "b".repeat(48), status: "pending" },
  { email: "c@example.com", token: "c".repeat(48), status: "unsubscribed" },
  { email: "d@example.com", token: "d".repeat(48), status: "confirmed" },
];

function env(db = fakeDb(subs)): Env & { DB: ReturnType<typeof fakeDb> } {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response(TEMPLATE, { status: 200 }) },
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_test",
    MAIL_FROM: "AURA <brief@example.org>",
    SITE_URL: "https://auranews.pages.dev",
    BRIEF_SEND_SECRET: SECRET,
    OWNER_EMAIL: "owner@example.org",
    RESEND_API_BASE: "https://resend.test",
  } as Env & { DB: ReturnType<typeof fakeDb> };
}

const call = (e: Env, query = "", secret = SECRET) =>
  onRequestPost({
    request: new Request(`https://auranews.pages.dev/api/send-brief${query}`, {
      method: "POST",
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    }),
    env: e,
  });

let sentBodies: unknown[][] = [];
let resendStatus = 200;
const realFetch = globalThis.fetch;
beforeEach(() => {
  sentBodies = [];
  resendStatus = 200;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://resend.test/emails/batch");
    sentBodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: resendStatus });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("refuses a missing or wrong secret", async () => {
  assert.equal((await call(env(), "", "")).status, 401);
  assert.equal((await call(env(), "", "wrong-secret-xxxxxxxx")).status, 401);
  assert.equal(sentBodies.length, 0);
});

test("dry run counts confirmed subscribers and sends nothing", async () => {
  const res = await call(env(), "?dry_run=1");
  const body = await res.json();
  assert.equal(body.recipients, 2);
  assert.equal(body.edition, "20261022-074512");
  assert.equal(sentBodies.length, 0);
});

test("sends only to confirmed subscribers, each with their own unsubscribe link and headers", async () => {
  const e = env();
  const body = await (await call(e)).json();
  assert.equal(body.sent, 2);
  assert.equal(body.failed, 0);
  const batch = sentBodies[0] as { to: string[]; subject: string; html: string; text: string; headers: Record<string, string> }[];
  assert.deepEqual(batch.map((m) => m.to[0]), ["a@example.com", "d@example.com"]);
  assert.equal(batch[0].subject, "AURA Morning Brief · Thursday 22 October");
  assert.ok(batch[0].html.includes(`/api/unsubscribe?token=${"a".repeat(48)}`));
  assert.ok(!batch[0].html.includes("{{unsubscribe_url}}"));
  assert.equal(batch[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.ok(batch[1].headers["List-Unsubscribe"].includes("d".repeat(48)));
  assert.ok(batch[0].text.includes("Read the full brief (https://auranews.pages.dev/brief/)"));
});

test("a second call the same day sends nothing", async () => {
  const e = env();
  await call(e);
  const again = await (await call(e)).json();
  assert.equal(again.skipped, "already_sent_today");
  assert.equal(sentBodies.length, 1);
});

test("an edition already sent on an earlier day is not sent again", async () => {
  const e = env();
  e.DB.sends.set("2026-10-21", { edition: "20261022-074512", finished_at: "2026-10-21T07:20:00Z", sent: 2, failed: 0 });
  const body = await (await call(e)).json();
  assert.equal(body.skipped, "edition_already_sent");
  assert.equal(sentBodies.length, 0);
});

test("a Resend failure is counted, not hidden", async () => {
  resendStatus = 500;
  const res = await call(env());
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.failed, 2);
  assert.equal(body.sent, 0);
});

/** A pending sign-up `hours` old whose confirmation went out `mails` times on its first Lagos day. */
function addPending(db: ReturnType<typeof fakeDb>, email: string, token: string, hours: number, mails = 1, lastMailedHours = hours): void {
  const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  addSubscriber(db, { email, token, status: "pending", created_at: at(hours) });
  db.raw
    .prepare("UPDATE subscribers SET last_mailed_at = ?, mail_day = ?, mails_today = ? WHERE email = ?")
    .run(at(lastMailedHours), lagosDay(new Date(Date.now() - hours * 3_600_000)), mails, email);
}

test("after a send: stale pending rows go, and a 48-72h pending sign-up gets one reminder", async () => {
  const e = env();
  addPending(e.DB, "remind@x.co", "1".repeat(48), 60);
  addPending(e.DB, "twice@x.co", "2".repeat(48), 60, 2);
  addPending(e.DB, "young@x.co", "3".repeat(48), 10);
  addPending(e.DB, "old@x.co", "4".repeat(48), 24 * 40);
  addPending(e.DB, "reopened@x.co", "5".repeat(48), 24 * 40, 1, 24);
  const body = await (await call(e)).json();
  assert.deepEqual(body.housekeeping, { pending_deleted: 1, reminders_sent: 1, reminders_failed: 0 });
  assert.equal(sentBodies.length, 2, "the brief, then the reminders");
  const reminders = sentBodies[1] as { to: string[]; subject: string; html: string; headers: Record<string, string> }[];
  assert.deepEqual(reminders.map((m) => m.to[0]), ["remind@x.co"]);
  assert.match(reminders[0].subject, /Confirm/);
  assert.ok(reminders[0].html.includes(`/api/confirm?token=${"1".repeat(48)}`));
  assert.ok(reminders[0].headers["List-Unsubscribe"].includes("1".repeat(48)));
  const left = (e.DB.raw.prepare("SELECT email FROM subscribers WHERE status = 'pending' ORDER BY email").all() as { email: string }[]).map((r) => r.email);
  assert.deepEqual(left, ["b@example.com", "remind@x.co", "reopened@x.co", "twice@x.co", "young@x.co"]);
  const reminded = e.DB.raw.prepare("SELECT mails_today, mail_day FROM subscribers WHERE email = 'remind@x.co'").get() as { mails_today: number; mail_day: string };
  assert.deepEqual([reminded.mails_today, reminded.mail_day], [1, lagosDay(new Date())], "the reminder counts against today's limit");
});

test("reminders are capped at 20 a run, and a dry run does no housekeeping", async () => {
  const e = env();
  for (let i = 0; i < 25; i++) addPending(e.DB, `p${i}@x.co`, i.toString(16).padStart(2, "0").repeat(24), 50);
  addPending(e.DB, "old@x.co", "f".repeat(48), 24 * 40);
  await call(e, "?dry_run=1");
  assert.equal(sentBodies.length, 0);
  assert.ok(e.DB.raw.prepare("SELECT 1 FROM subscribers WHERE email = 'old@x.co'").get(), "a dry run deletes nothing");
  const body = await (await call(e)).json();
  assert.equal(body.housekeeping.reminders_sent, 20);
  assert.equal((sentBodies[1] as unknown[]).length, 20);
});

test("a housekeeping failure is reported without failing the send", async () => {
  const e = env();
  e.DB.raw.exec("DROP TABLE throttle");
  const res = await call(e);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sent, 2);
  assert.match(body.housekeeping.error, /throttle/);
});

test("test mode sends one copy to the owner and records nothing", async () => {
  const e = env();
  const body = await (await call(e, "?test=1")).json();
  assert.equal(body.test, true);
  assert.equal(sentBodies.length, 1);
  assert.deepEqual((sentBodies[0] as { to: string[] }[])[0].to, ["owner@example.org"]);
  assert.equal(e.DB.sends.size, 0);
});

test("helpers", () => {
  assert.ok(sameSecret("abc", "abc"));
  assert.ok(!sameSecret("abc", "abd"));
  assert.ok(!sameSecret("abc", "abcd"));
  assert.equal(lagosDay(new Date("2026-10-21T23:30:00Z")), "2026-10-22");
  assert.equal(readMeta(TEMPLATE, "aura-edition"), "20261022-074512");
  assert.equal(personalise('<a href="{{unsubscribe_url}}">x</a>', "https://x/u?token=1&a=2"), '<a href="https://x/u?token=1&amp;a=2">x</a>');
  assert.equal(htmlToText("<p>One &amp; two</p><p>Three</p>"), "One & two\nThree");
  assert.equal(htmlToText("<head><title>x</title><style>p{}</style></head><body><p>Hi</p><script>bad()</script></body>"), "Hi");
  assert.equal(htmlToText('<a href="https://a.b/?x=1&amp;y=2">Go</a>'), "Go (https://a.b/?x=1&y=2)");
  assert.equal(decodeEntities("&amp;lt;"), "&lt;", "decoded once, never twice");
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(batchPayload("F", [{ to: "x@y.z", subject: "s", html: "h", text: "t", unsubscribe: "u" }])[0].headers["List-Unsubscribe"], "<u>");
});

test("brevo: one call, one version per subscriber, each with only their own link", async () => {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response('{"messageIds":[]}', { status: 201 });
  }) as typeof fetch;
  const e = { ...env(), EMAIL_PROVIDER: "brevo", RESEND_API_KEY: undefined, BREVO_API_KEY: "xkeysib-test", BREVO_API_BASE: "https://brevo.test" };
  const body = await (await call(e)).json();
  assert.equal(body.sent, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://brevo.test/v3/smtp/email");
  assert.equal(calls[0].headers["api-key"], "xkeysib-test");
  const payload = calls[0].body;
  assert.deepEqual(payload.sender, { name: "AURA", email: "brief@example.org" });
  assert.ok(!payload.htmlContent.includes("token="), "the shared base carries nobody's link");
  assert.deepEqual(payload.messageVersions.map((v: any) => v.to[0].email), ["a@example.com", "d@example.com"]);
  assert.ok(payload.messageVersions[0].htmlContent.includes("a".repeat(48)));
  assert.ok(!payload.messageVersions[0].htmlContent.includes("d".repeat(48)));
});

test("parseFrom", () => {
  assert.deepEqual(parseFrom("AURA Morning Brief <me@gmail.com>"), { name: "AURA Morning Brief", email: "me@gmail.com" });
  assert.deepEqual(parseFrom('"AURA" <me@gmail.com>'), { name: "AURA", email: "me@gmail.com" });
  assert.deepEqual(parseFrom("me@gmail.com"), { email: "me@gmail.com" });
});

test("gmail: one SMTP session, confirmed subscribers only, each with their own link", async () => {
  const server = fakeSmtp({ password: "abcdefghijklmnop" });
  const realOpen = smtpTransport.open;
  smtpTransport.open = () => server.open;
  try {
    const e = {
      ...env(),
      EMAIL_PROVIDER: "gmail",
      RESEND_API_KEY: undefined,
      MAIL_FROM: undefined,
      GMAIL_USER: "aura.owner@gmail.com",
      GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop",
    };
    const body = await (await call(e)).json();
    assert.equal(body.sent, 2);
    assert.equal(body.failed, 0);
    assert.equal(sentBodies.length, 0, "no HTTP email API was called");
    assert.deepEqual(server.delivered.map((m) => m.to), ["a@example.com", "d@example.com"]);
    assert.equal(server.delivered[0].from, "aura.owner@gmail.com");
    assert.match(server.delivered[0].data, /^From: AURA Morning Brief <aura\.owner@gmail\.com>$/m);
    assert.match(server.delivered[0].data, new RegExp(`List-Unsubscribe: <[^>]*token=${"a".repeat(48)}>`));
    assert.ok(!server.delivered[0].data.includes("d".repeat(48)));
  } finally {
    smtpTransport.open = realOpen;
  }
});

test("gmailFrom keeps a matching MAIL_FROM and otherwise uses the Gmail address", () => {
  assert.equal(gmailFrom({ GMAIL_USER: "me@gmail.com" }), "AURA Morning Brief <me@gmail.com>");
  assert.equal(gmailFrom({ GMAIL_USER: "me@gmail.com", MAIL_FROM: "AURA <me@gmail.com>" }), "AURA <me@gmail.com>");
  assert.equal(gmailFrom({ GMAIL_USER: "me@gmail.com", MAIL_FROM: "AURA <brief@other.org>" }), "AURA Morning Brief <me@gmail.com>");
});

test("scripts never reach the inbox", async () => {
  assert.equal(stripScripts('<p>a</p><script type="module" src="/x.js"></script><p>b</p><SCRIPT>1</SCRIPT>'), "<p>a</p><p>b</p>");
  assert.equal(stripScripts("<p>a</p><script>unclosed"), "<p>a</p>");
  await call(env());
  const batch = sentBodies[0] as { html: string }[];
  assert.ok(!batch[0].html.includes("<script"));
});
