import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  buildFor, composeEmail, extractSection, filterRegions, groupRecipients, hoursOld, isDue, onRequestPost, SECTIONS_SLOT,
  type Templates,
} from "./send-brief.ts";
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
<body><table><tr><td>MASTHEAD</td></tr>${SECTIONS_SLOT}<tr><td><a href="{{preferences_url}}">Change topics</a> <a href="{{unsubscribe_url}}">Unsubscribe</a></td></tr></table></body></html>`;
const section = (name: string, generated = "2026-11-06 05:00:00") => `<!DOCTYPE html><meta name="aura-generated" content="${generated}" /><table>
<!--aura:section--><tr><td>${name.toUpperCase()}</td></tr><!--region:nigeria--><tr><td>${name} NG</td></tr><!--/region:nigeria--><!--region:global--><tr><td>${name} WORLD</td></tr><!--/region:global--><!--/aura:section--></table>`;

const T = (c: string) => c.repeat(48);

function env(pages: Record<string, string> = {}): Env & { DB: ReturnType<typeof sqliteD1> } {
  const all: Record<string, string> = {
    "/brief/email/": BUSINESS,
    "/brief/email/shell/": SHELL,
    "/brief/email/section/sports/": section("sports"),
    "/brief/email/section/politics/": section("politics"),
    "/brief/email/section/technology/": section("technology", "2026-11-03 05:00:00"), // stale
    ...pages,
  };
  const db = sqliteD1();
  addSubscriber(db, { email: "biz@x.co", token: T("a") });
  addSubscriber(db, { email: "sport@x.co", token: T("b"), categories: "sports", region: "global" });
  addSubscriber(db, { email: "mix@x.co", token: T("c"), categories: "business,politics", region: "both" });
  addSubscriber(db, { email: "mix2@x.co", token: T("d"), categories: "business,politics", region: "both" });
  addSubscriber(db, { email: "weekly@x.co", token: T("e"), categories: "sports", region: "nigeria", frequency: "weekly" });
  addSubscriber(db, { email: "tech@x.co", token: T("f"), categories: "technology" });
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
  assert.equal(batches.length, 3, "business, sports-global and business+politics: one batch each");
  const got = byRecipient();

  assert.match(got["biz@x.co"].html, /BUSINESS STORIES/);
  assert.doesNotMatch(got["biz@x.co"].html, /SPORTS|POLITICS|aura:sections/);

  const sport = got["sport@x.co"];
  assert.match(sport.html, /MASTHEAD/);
  assert.match(sport.html, /sports WORLD/);
  assert.doesNotMatch(sport.html, /sports NG|BUSINESS/);
  assert.equal(sport.subject, "AURA Morning Brief · Friday 6 November · Sports");

  const mix = got["mix@x.co"];
  assert.match(mix.html, /BUSINESS STORIES[\s\S]*politics NG[\s\S]*politics WORLD/);
  assert.equal(mix.subject, "AURA Morning Brief · Friday 6 November");
  assert.match(mix.html, new RegExp(`/api/preferences\\?token=${T("c")}`));
  assert.match(mix.text, new RegExp(`Change topics \\(https://auranews.pages.dev/api/preferences\\?token=${T("c")}\\)`));
  assert.ok(!got["mix2@x.co"].html.includes(T("c")), "each copy carries only its own links");
});

test("weekly readers wait for Monday; paused readers and stale headlines are skipped", async () => {
  await call(env());
  const got = byRecipient();
  assert.equal(got["weekly@x.co"], undefined);
  assert.equal(got["paused@x.co"], undefined);
  assert.equal(got["tech@x.co"], undefined, "technology headlines are three days old");
});

test("on Monday weekly readers are included", async () => {
  mock.timers.setTime(MONDAY.getTime());
  const fresh = { "/brief/email/section/sports/": section("sports", "2026-11-09 05:00:00") };
  const body = await (await call(env(fresh), "?dry_run=1")).json();
  const weekly = body.groups.find((g: { mix: string }) => g.mix === "sports|nigeria");
  assert.deepEqual(weekly, { mix: "sports|nigeria", readers: 1, subject: "AURA Morning Brief · Friday 6 November · Sports" });
});

test("dry run reports every mix and sends nothing", async () => {
  const body = await (await call(env(), "?dry_run=1")).json();
  assert.equal(batches.length, 0);
  assert.equal(body.recipients, 4);
  assert.equal(body.skipped_readers, 1);
  assert.deepEqual(body.headline_sections.sort(), ["politics", "sports"]);
  assert.deepEqual(body.groups.map((g: { mix: string }) => g.mix).sort(), ["business,politics|both", "business|-", "sports|global", "technology|nigeria"]);
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
  const body = await (await call(env(), "?test=1&categories=sports,politics&region=nigeria")).json();
  assert.equal(body.test, true);
  const [mail] = batches[0];
  assert.deepEqual(mail.to, ["owner@example.org"]);
  assert.match(mail.html, /sports NG[\s\S]*politics NG/);
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
  const groups = groupRecipients([s("a", ["business"], "global"), s("b", ["business"], "nigeria"), s("c", ["sports"], "global")]);
  assert.deepEqual(groups.map((g) => [g.key, g.readers.length]), [["business|-", 2], ["sports|global", 1]]);
  const t: Templates = { business: null, shell: { html: SHELL, subject: "S" }, sections: {} };
  assert.equal(buildFor({ categories: ["sports"], region: "global", frequency: "daily" }, t, true), null, "nothing fresh, nothing sent");
});
