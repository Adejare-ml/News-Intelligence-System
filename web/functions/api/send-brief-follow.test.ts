import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  buildFor, followingBlock, groupRecipients, onRequestPost, rankFollows, MAX_FOLLOW_FETCHES, SECTIONS_SLOT,
  type Following, type Templates,
} from "./send-brief.ts";
import { addSubscriber, sqliteD1 } from "../_lib/d1-fake.test.ts";
import { followStore } from "../_lib/follows.ts";
import type { Env } from "../_lib/http.ts";
import type { Subscriber } from "../_lib/subscribers.ts";

const SECRET = "s3cret-for-tests-0123456789";
const NOW = new Date("2026-11-06T06:10:00Z");
const SITE = "https://auranews.pages.dev";
const T = (c: string) => c.repeat(48);

const BUSINESS = `<!doctype html><html><head><meta name="aura-edition" content="ed-1106" /><meta name="aura-subject" content="AURA Morning Brief · Friday 6 November" /></head>
<body><table><tr><td>BUSINESS STORIES</td></tr>${SECTIONS_SLOT}<tr><td><a href="{{preferences_url}}">Change topics</a> <a href="{{unsubscribe_url}}">Unsubscribe</a></td></tr></table></body></html>`;
const SHELL = `<!doctype html><html><head><meta name="aura-subject" content="AURA Morning Brief · Friday 6 November" /></head>
<body><table><tr><td>MASTHEAD</td></tr>${SECTIONS_SLOT}<tr><td><a href="{{preferences_url}}">Change topics</a> <a href="{{unsubscribe_url}}">Unsubscribe</a></td></tr></table></body></html>`;
const TECHNOLOGY = `<meta name="aura-generated" content="2026-11-06 05:00:00" /><table><!--aura:section--><tr><td>TECHNOLOGY</td></tr><!--region:nigeria--><tr><td>technology NG</td></tr><!--/region:nigeria--><!--region:global--><tr><td>technology WORLD</td></tr><!--/region:global--><!--/aura:section--></table>`;
const fragment = (name: string, empty = false, generated = "2026-11-06T05:00:00.000Z") =>
  `<meta name="aura-generated" content="${generated}" /><table><!--aura:section--><tr><td>${name}</td></tr>${empty ? "<!--empty--><tr><td>none</td></tr>" : `<tr><td>${name} NEWS</td></tr>`}<tr><td><a href="{{preferences_url}}">Unfollow ${name}</a></td></tr><!--/aura:section--></table>`;

const COMPANIES = [
  { slug: "dangote-cement", name: "Dangote Cement" },
  { slug: "mtn-nigeria", name: "MTN Nigeria" },
  { slug: "quiet-co", name: "Quiet Co" },
  { slug: "stale-co", name: "Stale Co" },
];

let fetched: string[] = [];
function env(pages: Record<string, string> = {}, companies = COMPANIES): Env & { DB: ReturnType<typeof sqliteD1> } {
  const all: Record<string, string> = {
    "/brief/email/": BUSINESS,
    "/brief/email/shell/": SHELL,
    "/brief/email/section/technology/": TECHNOLOGY,
    "/brief/email/follow/index.json": JSON.stringify({ companies }),
    "/brief/email/follow/dangote-cement/": fragment("Dangote Cement"),
    "/brief/email/follow/mtn-nigeria/": fragment("MTN Nigeria"),
    "/brief/email/follow/quiet-co/": fragment("Quiet Co", true),
    "/brief/email/follow/stale-co/": fragment("Stale Co", false, "2026-11-01T05:00:00.000Z"),
    ...pages,
  };
  return {
    DB: sqliteD1(),
    ASSETS: { fetch: async (r: Request | string) => {
      const path = new URL(typeof r === "string" ? r : r.url).pathname;
      fetched.push(path);
      return all[path] ? new Response(all[path]) : new Response("nope", { status: 404 });
    } },
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_test",
    MAIL_FROM: "AURA <brief@example.org>",
    SITE_URL: SITE,
    BRIEF_SEND_SECRET: SECRET,
    RESEND_API_BASE: "https://resend.test",
  } as Env & { DB: ReturnType<typeof sqliteD1> };
}

const call = (e: Env, query = "") =>
  onRequestPost({ request: new Request(`${SITE}/api/send-brief${query}`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } }), env: e });

type Sent = { to: string[]; subject: string; html: string; text: string }[];
let batches: Sent[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  batches = [];
  fetched = [];
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
const follow = (e: ReturnType<typeof env>, token: string, ...slugs: string[]) =>
  Promise.all(slugs.map((s) => followStore(e.DB).add(token, s, "2026-11-05T07:00:00Z")));

test("followers get a Following block after their sections; everyone else shares one email", async () => {
  const e = env();
  addSubscriber(e.DB, { email: "plain@x.co", token: T("a"), categories: "business,technology" });
  addSubscriber(e.DB, { email: "quiet@x.co", token: T("b"), categories: "business,technology" });
  addSubscriber(e.DB, { email: "f1@x.co", token: T("c"), categories: "business,technology" });
  addSubscriber(e.DB, { email: "f2@x.co", token: T("d"), categories: "business,technology" });
  addSubscriber(e.DB, { email: "f3@x.co", token: T("e"), categories: "business,technology" });
  await follow(e, T("b"), "quiet-co", "stale-co", "gone-co");
  await follow(e, T("c"), "dangote-cement", "quiet-co");
  await follow(e, T("d"), "dangote-cement");
  await follow(e, T("e"), "dangote-cement", "mtn-nigeria");

  const body = await (await call(e)).json();
  assert.equal(body.sent, 5);
  assert.equal(body.groups.length, 3, "no follow news / Dangote only / Dangote + MTN");
  assert.ok(body.groups.every((g: { mix: string }) => !/dangote|mtn/.test(g.mix)), "the reported mix hashes follows instead of naming them");
  assert.deepEqual(body.following, { followed: 5, fetched: 4, with_news: ["dangote-cement", "mtn-nigeria"], listed_only: 0 });
  assert.equal(fetched.filter((p) => p.startsWith("/brief/email/follow/") && p !== "/brief/email/follow/index.json").length, 4, "each fragment fetched once; unknown companies never");

  const got = byRecipient();
  assert.equal(got["plain@x.co"].html, got["quiet@x.co"].html.replace(T("b"), T("a")).replace(T("b"), T("a")), "no news on your follows: the same email as a non-follower");
  assert.doesNotMatch(got["quiet@x.co"].html, /Following|Quiet Co|Stale Co/);

  const f3 = got["f3@x.co"].html;
  assert.match(f3, /BUSINESS STORIES[\s\S]*technology NG[\s\S]*>Following<[\s\S]*Dangote Cement NEWS[\s\S]*MTN Nigeria NEWS[\s\S]*Change topics/);
  assert.ok(f3.includes(`<a href="${SITE}/api/preferences?token=${T("e")}">Unfollow MTN Nigeria</a>`), "unfollow points at the reader's own preferences page");
  assert.doesNotMatch(got["f1@x.co"].html, /MTN|Quiet Co/);
  assert.match(got["f1@x.co"].text, /Unfollow Dangote Cement \(https:\/\/auranews\.pages\.dev\/api\/preferences\?token=c{48}\)/);
});

test("follow news alone is worth an email when the business edition was already sent", async () => {
  const e = env();
  addSubscriber(e.DB, { email: "f@x.co", token: T("a") });
  addSubscriber(e.DB, { email: "plain@x.co", token: T("b") });
  await follow(e, T("a"), "mtn-nigeria");
  e.DB.raw.prepare("INSERT INTO sends (day, edition, started_at, finished_at) VALUES ('2026-11-05', 'ed-1106', 'x', 'y')").run();
  const body = await (await call(e)).json();
  assert.equal(body.recipients, 1);
  const got = byRecipient();
  assert.equal(got["plain@x.co"], undefined);
  assert.match(got["f@x.co"].html, /MASTHEAD[\s\S]*>Following<[\s\S]*MTN Nigeria NEWS/);
  assert.equal(got["f@x.co"].subject, "AURA Morning Brief · Friday 6 November · Following");
});

test(`at most ${MAX_FOLLOW_FETCHES} fragments are fetched; the rest are listed as links`, async () => {
  const many = Array.from({ length: MAX_FOLLOW_FETCHES + 2 }, (_, i) => ({ slug: `co-${String(i).padStart(2, "0")}`, name: `Co ${i}` }));
  const pages = Object.fromEntries(many.map((c) => [`/brief/email/follow/${c.slug}/`, fragment(c.name)]));
  const e = env(pages, many);
  // 16 readers following two companies each: 32 companies in all, the most popular first.
  for (let i = 0; i < 16; i++) {
    addSubscriber(e.DB, { email: `r${i}@x.co`, token: T(i.toString(16)) });
    await follow(e, T(i.toString(16)), many[i * 2].slug, many[i * 2 + 1].slug);
  }
  const body = await (await call(e)).json();
  assert.equal(body.following.fetched, MAX_FOLLOW_FETCHES);
  assert.equal(body.following.listed_only, 2);
  const last = byRecipient()["r15@x.co"].html;
  assert.match(last, />Following<[\s\S]*Also following/);
  assert.ok(last.includes(`<a href="${SITE}/entity/co-31/"`));
  assert.doesNotMatch(last, /Co 31 NEWS/);
});

test("pure helpers: ranking, grouping and the block", () => {
  const r = (token: string): Subscriber => ({ email: `${token[0]}@x.co`, token, status: "confirmed", paused: false, categories: ["business"], region: "nigeria", frequency: "daily" });
  const follows = new Map([[T("a"), ["b-co", "a-co"]], [T("b"), ["a-co"]], [T("c"), ["c-co"]]]);
  assert.deepEqual(rankFollows([r(T("a")), r(T("b")), r(T("c"))], follows), ["a-co", "b-co", "c-co"]);
  assert.deepEqual(rankFollows([r(T("c"))], follows), ["c-co"], "only due readers count");

  const following: Following = { fragments: new Map([["a-co", "<tr><td>A</td></tr>"]]), unfetched: new Map(), fetched: 1 };
  const groups = groupRecipients([r(T("a")), r(T("b")), r(T("c")), r(T("d"))], follows, following);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.readers.length), [2, 2]);
  assert.match(groups[0].key, /^business\|-\|follow:[0-9a-f]{8}$/);
  assert.deepEqual(groups[0].follow, { news: ["a-co"], more: [] });
  assert.equal(groups[1].key, groupRecipients([r(T("d"))])[0].key, "readers without follow news keep the plain key");

  assert.equal(followingBlock([], [], SITE), "");
  const block = followingBlock(["<tr><td>A</td></tr>"], [{ slug: "x-co", name: "X & Co" }], SITE);
  assert.match(block, />Following<[\s\S]*<tr><td>A<\/td><\/tr>[\s\S]*Also following[\s\S]*<a href="https:\/\/auranews\.pages\.dev\/entity\/x-co\/"[^>]*>X &amp; Co<\/a>/);

  const t: Templates = { business: null, shell: { html: SHELL, subject: "S" }, sections: {} };
  assert.equal(buildFor({ categories: ["business"], region: "nigeria", frequency: "daily" }, t, false, { html: block, hasNews: false }), null, "names to look up are not news");
});

test("the daily send deletes follow-form addresses older than a day, even if nobody uses the form again", async () => {
  const e = env();
  const add = e.DB.raw.prepare("INSERT INTO follow_requests (email, requested_at) VALUES (?, ?)");
  add.run("stranger@x.org", "2026-11-04T06:00:00.000Z");
  add.run("recent@x.org", "2026-11-06T05:00:00.000Z");
  assert.equal((await call(e)).status, 200);
  const rows = e.DB.raw.prepare("SELECT email FROM follow_requests").all() as { email: string }[];
  assert.deepEqual(rows.map((r) => r.email), ["recent@x.org"]);
});

test("a database without the follows table (0007 not applied) still sends the brief", async () => {
  const e = env();
  addSubscriber(e.DB, { email: "plain@x.co", token: T("a") });
  e.DB.raw.exec("DROP TABLE follows");
  const res = await call(e);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sent, 1);
  assert.match(body.following.error, /follows/);
});
