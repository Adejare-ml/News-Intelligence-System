import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { onRequestPost, sameSecret, lagosDay, readMeta } from "./send-brief.ts";
import { personalise, htmlToText, batchPayload, chunk } from "../_lib/mailer.ts";
import type { Env } from "../_lib/http.ts";

const SECRET = "s3cret-for-tests-0123456789";
const TEMPLATE = `<!doctype html><html><head>
<meta name="aura-edition" content="20261022-074512" />
<meta name="aura-subject" content="AURA Morning Brief · Thursday 22 October" />
</head><body><p>Hello &amp; welcome</p><a href="https://auranews.pages.dev/brief/">Read the full brief</a>
<a href="{{unsubscribe_url}}">Unsubscribe</a></body></html>`;

/** A tiny in-memory stand-in for the D1 calls the endpoint makes. */
function fakeDb(subscribers: { email: string; token: string; status: string }[]) {
  const sends = new Map<string, { edition: string; finished_at: string | null; sent: number; failed: number }>();
  const db = {
    sends,
    prepare(sql: string) {
      return {
        bind(...v: unknown[]) {
          return {
            async first<T>() {
              if (sql.startsWith("SELECT edition, finished_at FROM sends")) return (sends.get(String(v[0])) ?? null) as T;
              if (sql.startsWith("SELECT day FROM sends WHERE edition")) {
                for (const [day, row] of sends) if (row.edition === v[0] && row.finished_at) return { day } as T;
                return null;
              }
              return null;
            },
            async all<T>() {
              return { results: subscribers.filter((s) => s.status === "confirmed").map(({ email, token }) => ({ email, token })) as T[] };
            },
            async run() {
              if (sql.startsWith("INSERT INTO sends")) sends.set(String(v[0]), { edition: String(v[1]), finished_at: null, sent: 0, failed: 0 });
              if (sql.startsWith("UPDATE sends")) {
                const row = sends.get(String(v[3]))!;
                Object.assign(row, { finished_at: String(v[0]), sent: Number(v[1]), failed: Number(v[2]) });
              }
              return {};
            },
          };
        },
      };
    },
  };
  return db;
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
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(batchPayload("F", [{ to: "x@y.z", subject: "s", html: "h", text: "t", unsubscribe: "u" }])[0].headers["List-Unsubscribe"], "<u>");
});
