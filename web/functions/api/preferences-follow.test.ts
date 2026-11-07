import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestGet as prefsGet, onRequestPost as prefsPost, followSection } from "./preferences.ts";
import { addSubscriber, sqliteD1 } from "../_lib/d1-fake.test.ts";
import { followStore, MAX_FOLLOWS } from "../_lib/follows.ts";
import { subscriberStore } from "../_lib/subscribers.ts";
import type { Env } from "../_lib/http.ts";

const SITE = "https://auranews.pages.dev";
const T = (c: string) => c.repeat(48);
const INDEX = { companies: [{ slug: "dangote-cement-plc", name: "Dangote Cement Plc" }, { slug: "mtn-nigeria", name: "MTN Nigeria" }, { slug: "a-and-b", name: "A & B <Holdings>" }] };

function env(): Env & { DB: ReturnType<typeof sqliteD1> } {
  const db = sqliteD1();
  addSubscriber(db, { email: "r@x.co", token: T("a"), categories: "business,sports" });
  return {
    DB: db,
    ASSETS: { fetch: async (r: Request | string) => {
      const path = new URL(typeof r === "string" ? r : r.url).pathname;
      return path === "/brief/email/follow/index.json" ? new Response(JSON.stringify(INDEX)) : new Response("nope", { status: 404 });
    } },
  };
}

const url = `${SITE}/api/preferences?token=${T("a")}`;
const post = (e: Env, fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return prefsPost({ request: new Request(url, { method: "POST", body: fd }), env: e });
};

test("the preferences page lists follows with unfollow buttons and an add field", async () => {
  const e = env();
  await followStore(e.DB).add(T("a"), "mtn-nigeria", "2026-11-06T07:00:00Z");
  await followStore(e.DB).add(T("a"), "gone-company", "2026-11-06T07:00:00Z");
  const html = await (await prefsGet({ request: new Request(url), env: e })).text();
  assert.match(html, /id="following"/);
  assert.match(html, /name="follow_action" value="remove"><input type="hidden" name="slug" value="mtn-nigeria">\n<span>MTN Nigeria<\/span>/);
  assert.match(html, /gone-company/, "a company that lost its page can still be unfollowed");
  assert.match(html, /name="follow_action" value="add"/);
  assert.match(html, /<option value="Dangote Cement Plc">/);
  assert.match(html, /<option value="A &amp; B &lt;Holdings&gt;">/, "names are escaped");
});

test("adding by name, unfollowing, and refusing unknown companies", async () => {
  const e = env();
  const added = await post(e, { follow_action: "add", company: "dangote cement plc" });
  assert.equal(added.status, 200);
  assert.match(await added.text(), /You now follow Dangote Cement Plc/);
  assert.deepEqual(await followStore(e.DB).list(T("a")), ["dangote-cement-plc"]);

  const unknown = await post(e, { follow_action: "add", company: "Some Person" });
  assert.equal(unknown.status, 400);
  assert.deepEqual(await followStore(e.DB).list(T("a")), ["dangote-cement-plc"]);

  const removed = await post(e, { follow_action: "remove", slug: "dangote-cement-plc" });
  assert.match(await removed.text(), /no longer follow Dangote Cement Plc/);
  assert.deepEqual(await followStore(e.DB).list(T("a")), []);
  assert.deepEqual((await subscriberStore(e.DB).byToken(T("a")))!.categories, ["business", "sports"], "follow buttons leave topics alone");
});

test(`the add field disappears at ${MAX_FOLLOWS} follows and a forced add is refused`, async () => {
  const e = env();
  for (let i = 0; i < MAX_FOLLOWS; i++) await followStore(e.DB).add(T("a"), `co-${i}`, "2026-11-06T07:00:00Z");
  const html = followSection(T("a"), await followStore(e.DB).list(T("a")), new Map(INDEX.companies.map((c) => [c.slug, c.name])));
  assert.doesNotMatch(html, /value="add"/);
  assert.match(html, new RegExp(`${MAX_FOLLOWS} companies`));
  const res = await post(e, { follow_action: "add", company: "MTN Nigeria" });
  assert.equal(res.status, 409);
});

test("without the follows table (0007 not applied) topics can still be changed", async () => {
  const e = env();
  e.DB.raw.exec("DROP TABLE follows");
  const page = await prefsGet({ request: new Request(url), env: e });
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /id="following"/);
  const saved = await post(e, { categories: "sports", region: "global", frequency: "daily" });
  assert.equal(saved.status, 200);
  assert.deepEqual((await subscriberStore(e.DB).byToken(T("a")))!.categories, ["sports"]);
});

test("an unsubscribed reader's link manages nothing", async () => {
  const e = env();
  e.DB.raw.prepare("UPDATE subscribers SET status = 'unsubscribed'").run();
  await post(e, { follow_action: "add", company: "MTN Nigeria" });
  assert.deepEqual(await followStore(e.DB).list(T("a")), []);
});
