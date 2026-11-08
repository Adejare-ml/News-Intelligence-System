import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  buildFor, composeEmail, extractSection, filterRegions, groupRecipients, hasHeadlines, hoursOld, isDue, onRequestPost, SECTIONS_SLOT,
  type Templates,
} from "./send-brief.ts";
import { smtpTransport } from "../_lib/mailer.ts";
import { fakeSmtp } from "../_lib/smtp-fake.test.ts";
import { addSubscriber, sqliteD1 } from "../_lib/d1-fake.test.ts";
import type { Env } from "../_lib/http.ts";
import type { Subscriber } from "../_lib/subscribers.ts";

const SECRET = "s3cret-for-tests-0123456789";
// Friday 6 November 2026, 07:10 Lagos.
const NOW = new Date("2026-11-06T06:10:00Z");
const MONDAY = new Date("2026-11-09T06:10:00Z");

const BUSINESS = `<!doctype html><html><head><meta name="aura-edition" content="ed-1106" /><meta name="aura-subject" content="AURA Morning Brief · Friday 6 November" /></head>
<body><table><tr><td>BUSINESS STORIES</td></tr>${SECTIONS_SLOT}<tr><td><a href="{{preferences_url}}">Change topics</a> <a href="{{unsubscribe_url}}">Unsubscribe</a></td></tr></table></body></html>`;
const SHELL = `<!doctype html><html><head><meta name="aura-subject" content="AURA Morning Brief · Friday 6 November" /></head>
<body><table><tr><td>MASTHEAD <!--aura:intro-->The headlines you chose<!--/aura:intro--></td></tr><tr><td><!--aura:source-->Google News<!--/aura:source--></td></tr>${SECTIONS_SLOT}<tr><td><a href="{{preferences_url}}">Change topics</a> <a href="{{unsubscribe_url}}">Unsubscribe</a></td></tr></table></body></html>`;
const section = (name: string, generated = "2026-11-06 05:00:00", empty: string[] = []) => {
  const region = (id: string, label: string) =>
    `<!--region:${id}-->${empty.includes(id) ? "<!--empty--><tr><td>none</td></tr>" : `<tr><td>${name} ${label}</td></tr>`}<!--/region:${id}-->`;
  return `<!DOCTYPE html><meta name="aura-generated" content="${generated}" /><table>
<!--aura:section--><tr><td>${name.toUpperCase()}</td></tr>${region("nigeria", "NG")}${region("global", "WORLD")}<!--/aura:section--></table>`;
};
const WEEK = (generated = "2026-11-08 21:00:00") => `<!DOCTYPE html><meta name="aura-generated" content="${generated}" /><meta name="aura-week" content="2026-11-02 to 2026-11-08" /><table>
<!--aura:section--><tr><td>WEEK IN BUSINESS</td></tr><!--/aura:section--></table>`;

const T = (c: string) => c.repeat(48);

function env(pages: Record<string, string> = {}): Env & { DB: ReturnType<typeof sqliteD1> } {
  const all: Record<string, string> = {
    "/brief/email/": BUSINESS,
    "/brief/email/shell/": SHELL,
    "/brief/email/section/technology/": section("technology"),
    "/brief/email/section/politics/": section("politics"),
    ...pages,
  };
  const db = sqliteD1();
  addSubscriber(db, { email: "biz@x.co", token: T("a") });
  addSubscriber(db, { email: "techworld@x.co", token: T("b"), categories: "technology", region: "global" });
  addSubscriber(db, { email: "mix@x.co", token: T("c"), categories: "business,politics", region: "both" });
  addSubscriber(db, { email: "mix2@x.co", token: T("d"), categories: "business,politics", region: "both" });
  addSubscriber(db, { email: "weekly@x.co", token: T("e"), categories: "technology", region: "nigeria", frequency: "weekly" });
  addSubscriber(db, { email: "paused@x.co", token: T("1"), paused: 1 });
  return {
    DB: db,
    ASSETS: { fetch: async (r: Request | string) => {
      const path = new URL(typeof r === "string" ? r : r.url).pathname;
      return all[path] ? new Response(all[path]) : new Response("nope", { status: 404 });
    } },
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_test",
    MAIL_FROM: "AURA <brief@example.org>",
    SITE_URL: "https://auranews.pages.dev",
    BRIEF_SEND_SECRET: SECRET,
    OWNER_EMAIL: "owner@example.org",
    RESEND_API_BASE: "https://resend.test",
  } as Env & { DB: ReturnType<typeof sqliteD1> };
}

const call = (e: Env, query = "") =>
  onRequestPost({ request: new Request(`https://auranews.pages.dev/api/send-brief${query}`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } }), env: e });

type Sent = { to: string[]; subject: string; html: string; text: string }[];
let batches: Sent[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  batches = [];
  mock.timers.enable({ apis: ["Date"], now: NOW });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    batches.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
});

const byRecipient = () => Object.fromEntries(batches.flat().map((m) => [m.to[0], m]));

test("each reader gets the mix they chose, built once per mix", async () => {
  const body = await (await call(env())).json();
  assert.equal(body.sent, 4);
  assert.equal(batches.length, 1, "three different mixes share one provider batch");
  assert.equal(new Set(batches[0].map((m) => m.subject + m.html.length)).size, 3, "three distinct emails");
  const got = byRecipient();

  assert.match(got["biz@x.co"].html, /BUSINESS STORIES/);
  assert.doesNotMatch(got["biz@x.co"].html, /TECHNOLOGY|POLITICS|aura:sections/);

  const tech = got["techworld@x.co"];
  assert.match(tech.html, /MASTHEAD/);
  assert.match(tech.html, /technology WORLD/);
  assert.doesNotMatch(tech.html, /technology NG|BUSINESS/);
  assert.equal(tech.subject, "AURA Morning Brief · Friday 6 November · Technology");

  const mix = got["mix@x.co"];
  assert.match(mix.html, /BUSINESS STORIES[\s\S]*politics NG[\s\S]*politics WORLD/);
  assert.equal(mix.subject, "AURA Morning Brief · Friday 6 November");
  assert.match(mix.html, new RegExp(`/api/preferences\\?token=${T("c")}`));
  assert.match(mix.text, new RegExp(`Change topics \\(https://auranews.pages.dev/api/preferences\\?token=${T("c")}\\)`));
  assert.ok(!got["mix2@x.co"].html.includes(T("c")), "each copy carries only its own links");
});

test("weekly readers wait for Monday; paused readers and stale headlines are skipped", async () => {
  await call(env({ "/brief/email/section/technology/": section("technology", "2026-11-03 05:00:00") }));
  const got = byRecipient();
  assert.equal(got["weekly@x.co"], undefined);
  assert.equal(got["paused@x.co"], undefined);
  assert.equal(got["techworld@x.co"], undefined, "technology headlines are three days old");
});

test("on Monday weekly readers are included", async () => {
  mock.timers.setTime(MONDAY.getTime());
  const fresh = { "/brief/email/section/technology/": section("technology", "2026-11-09 05:00:00") };
  const body = await (await call(env(fresh), "?dry_run=1")).json();
  const weekly = body.groups.find((g: { mix: string }) => g.mix === "technology|nigeria");
  assert.deepEqual(weekly, { mix: "technology|nigeria", readers: 1, subject: "AURA Morning Brief · Friday 6 November · Technology" });
});

test("dry run reports every mix and sends nothing", async () => {
  const body = await (await call(env(), "?dry_run=1")).json();
  assert.equal(batches.length, 0);
  assert.equal(body.recipients, 4);
  assert.equal(body.skipped_readers, 0);
  assert.deepEqual(body.headline_sections.sort(), ["politics", "technology"]);
  assert.deepEqual(body.groups.map((g: { mix: string }) => g.mix).sort(), ["business,politics|both", "business|-", "technology|global"]);
});

test("a stale business edition still lets headline readers through", async () => {
  const e = env();
  e.DB.raw.prepare("INSERT INTO sends (day, edition, started_at, finished_at, sent, failed) VALUES ('2026-11-05', 'ed-1106', 'x', 'y', 1, 0)").run();
  const body = await (await call(e)).json();
  assert.equal(body.business_fresh, false);
  const got = byRecipient();
  assert.equal(got["biz@x.co"], undefined, "business-only readers do not get the same edition twice");
  assert.match(got["mix@x.co"].html, /MASTHEAD[\s\S]*politics NG/);
  assert.doesNotMatch(got["mix@x.co"].html, /BUSINESS STORIES/);
  assert.equal(got["mix@x.co"].subject, "AURA Morning Brief · Friday 6 November · Politics");
});

test("test mode previews any mix to the owner", async () => {
  const body = await (await call(env(), "?test=1&categories=technology,politics&region=nigeria")).json();
  assert.equal(body.test, true);
  const [mail] = batches[0];
  assert.deepEqual(mail.to, ["owner@example.org"]);
  assert.match(mail.html, /technology NG[\s\S]*politics NG/);
  assert.doesNotMatch(mail.html, /WORLD/);
});

test("pure helpers", () => {
  assert.equal(extractSection(section("x")).startsWith("<tr><td>X</td></tr>"), true);
  assert.equal(extractSection("<p>no markers</p>"), "");
  assert.equal(filterRegions(extractSection(section("x")), ["global"]), "<tr><td>X</td></tr><tr><td>x WORLD</td></tr>");
  assert.equal(composeEmail(`a${SECTIONS_SLOT}b`, []), "ab");
  assert.equal(composeEmail(`a${SECTIONS_SLOT}b`, ["1", "2"]), "a1\n2b");
  assert.throws(() => composeEmail("no slot", ["1"]));
  assert.equal(isDue("daily", NOW), true);
  assert.equal(isDue("weekly", NOW), false);
  assert.equal(isDue("weekly", MONDAY), true);
  assert.equal(Math.round(hoursOld("2026-11-06 05:00:00", new Date("2026-11-06T06:00:00Z"))), 1);
  assert.equal(hoursOld("", NOW), Infinity);
  const s = (email: string, categories: Subscriber["categories"], region: Subscriber["region"]): Subscriber =>
    ({ email, token: "", status: "confirmed", paused: false, categories, region, frequency: "daily" });
  const groups = groupRecipients([s("a", ["business"], "global"), s("b", ["business"], "nigeria"), s("c", ["technology"], "global")]);
  assert.deepEqual(groups.map((g) => [g.key, g.readers.length]), [["business|-", 2], ["technology|global", 1]]);
  const t: Templates = { business: null, shell: { html: SHELL, subject: "S" }, sections: {} };
  assert.equal(buildFor({ categories: ["technology"], region: "global", frequency: "daily" }, t, true), null, "nothing fresh, nothing sent");
});

test("a category with no headlines in the reader's regions is left out", async () => {
  // Technology has only international headlines today; politics has both.
  const e = env({ "/brief/email/section/technology/": section("technology", "2026-11-06 05:00:00", ["nigeria"]) });
  addSubscriber(e.DB, { email: "ngtech@x.co", token: T("9"), categories: "technology", region: "nigeria" });
  addSubscriber(e.DB, { email: "ngmix@x.co", token: T("8"), categories: "technology,politics", region: "nigeria" });
  await call(e);
  const got = byRecipient();
  assert.equal(got["ngtech@x.co"], undefined, "nothing new for them: no email");
  assert.doesNotMatch(got["ngmix@x.co"].html, /TECHNOLOGY/);
  assert.match(got["ngmix@x.co"].html, /politics NG/);
  assert.equal(got["ngmix@x.co"].subject, "AURA Morning Brief · Friday 6 November · Politics");
  assert.match(got["techworld@x.co"].html, /technology WORLD/, "global readers still get technology");
});

test("weekly Business readers get the week in business on Mondays", async () => {
  mock.timers.setTime(MONDAY.getTime());
  const e = env({
    "/brief/email/section/business-week/": WEEK(),
    "/brief/email/section/politics/": section("politics", "2026-11-09 05:00:00"),
  });
  addSubscriber(e.DB, { email: "wbiz@x.co", token: T("7"), categories: "business,politics", region: "nigeria", frequency: "weekly" });
  await call(e);
  const got = byRecipient();
  const w = got["wbiz@x.co"];
  assert.match(w.html, /MASTHEAD[\s\S]*WEEK IN BUSINESS[\s\S]*politics NG/);
  assert.doesNotMatch(w.html, /BUSINESS STORIES/, "the week, not just Monday's brief");
  assert.match(w.html, /AURA’s own records, then the headlines you chose/);
  assert.match(w.html, /pipeline records[^<]*Google News/);
  assert.equal(w.subject, "AURA Morning Brief · Friday 6 November · The week in business and Politics");
  assert.match(got["biz@x.co"].html, /BUSINESS STORIES/, "daily readers still get the daily brief");
});

test("weekly Business readers fall back to Monday's brief when the wrap is stale", async () => {
  mock.timers.setTime(MONDAY.getTime());
  const e = env({ "/brief/email/section/business-week/": WEEK("2026-11-01 21:00:00") });
  addSubscriber(e.DB, { email: "wbiz@x.co", token: T("7"), categories: "business", frequency: "weekly" });
  await call(e);
  assert.match(byRecipient()["wbiz@x.co"].html, /BUSINESS STORIES/);
});

test("a week-only email says where it comes from, not Google News", async () => {
  mock.timers.setTime(MONDAY.getTime());
  const e = env({ "/brief/email/section/business-week/": WEEK() });
  addSubscriber(e.DB, { email: "wonly@x.co", token: T("6"), categories: "business", frequency: "weekly" });
  await call(e);
  const html = byRecipient()["wonly@x.co"].html;
  assert.match(html, /AURA’s own records\./);
  assert.doesNotMatch(html, /Google News|headlines you chose/);
});

test("gmail: one session and one daily cap across every mix", async () => {
  const server = fakeSmtp({ password: "abcdefghijklmnop" });
  const realOpen = smtpTransport.open;
  let sessions = 0;
  smtpTransport.open = () => { sessions++; return server.open; };
  try {
    const e = { ...env(), EMAIL_PROVIDER: "gmail", RESEND_API_KEY: undefined, MAIL_FROM: undefined, GMAIL_USER: "me@gmail.com", GMAIL_APP_PASSWORD: "abcdefghijklmnop" } as Env;
    const db = (e as unknown as { DB: ReturnType<typeof sqliteD1> }).DB;
    // 460 business readers plus the fixture's mixes: well over the cap of 450 in total.
    const insert = db.raw.prepare("INSERT INTO subscribers (email, token, status, created_at) VALUES (?, ?, 'confirmed', 'x')");
    for (let i = 0; i < 460; i++) insert.run(`r${i}@x.co`, i.toString(16).padStart(48, "0"));
    const body = await (await call(e)).json();
    assert.equal(sessions, 1);
    assert.equal(server.delivered.length, 450);
    assert.equal(body.sent, 450);
    assert.equal(body.failed, body.recipients - 450);
    assert.match(body.error, /Gmail daily cap/);
    assert.doesNotMatch(body.error, /^;/);
  } finally {
    smtpTransport.open = realOpen;
  }
});

test("hasHeadlines and $ in headlines", () => {
  const s = extractSection(section("x", "", ["nigeria"]));
  assert.equal(hasHeadlines(s, ["nigeria"]), false);
  assert.equal(hasHeadlines(s, ["global"]), true);
  assert.equal(hasHeadlines(s, ["nigeria", "global"]), true);
  assert.equal(composeEmail(`a${SECTIONS_SLOT}b`, ["N1,600/$&#39; and $& and $\`"]), "aN1,600/$&#39; and $& and $\`b");
});
