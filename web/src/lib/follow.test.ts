import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseFollows, toggleFollow, latestMention, hasNewFollowedAlert, followingFeed, companyNews, editionWindow, followableCompanies } from "./follow.ts";
import { cleanAlerts } from "./alerts.ts";
import type { Article } from "./stories.ts";
import { holderSlug, type Entity } from "./entities.ts";
import { slugify } from "./entity-key.ts";

const dangote = { slug: "dangote-refinery", name: "Dangote Refinery" };
const mtn = { slug: "mtn-nigeria", name: "MTN Nigeria" };

describe("following in the browser", () => {
  test("stored lists are read defensively", () => {
    assert.deepEqual(parseFollows(JSON.stringify([dangote])), [dangote]);
    assert.deepEqual(parseFollows(null), []);
    assert.deepEqual(parseFollows("not json"), []);
    assert.deepEqual(parseFollows('{"slug":"x"}'), []);
    assert.deepEqual(parseFollows(JSON.stringify([dangote, { slug: 3 }, { slug: "a" }])), [dangote]);
  });

  test("a person follow saved from a holder page is dropped, a company whose slug has '-at-' is kept", () => {
    // A person page is one holder at one company (#166), but Follow matched the
    // name alone, so another Abubakar Musa's arrest showed under the Kola holder.
    const holder = { slug: holderSlug("Abubakar Musa", "Kola Foods Ltd"), name: "Abubakar Musa" };
    const mosque = { slug: slugify("Shuni Central Jumu’at Mosque"), name: "Shuni Central Jumu’at Mosque" };
    assert.equal(mosque.slug, "shuni-central-jumu-at-mosque");
    const follows = parseFollows(JSON.stringify([holder, dangote, mosque]));
    assert.deepEqual(follows, [dangote, mosque]);
    const arrest = [{ date: "2026-11-04", title: "Abubakar Musa arrested in Kano", url: "https://p.test/arrest", source: "Punch", entities: ["Abubakar Musa"] }];
    assert.equal(hasNewFollowedAlert(arrest, follows, new Set()), false);
    assert.equal(latestMention(follows[0].name, [], arrest), null);
  });

  test("follow adds, a second press removes", () => {
    const once = toggleFollow([], dangote);
    assert.deepEqual(once, [dangote]);
    assert.deepEqual(toggleFollow(once, dangote), []);
    assert.deepEqual(toggleFollow(once, mtn), [dangote, mtn]);
  });

  test("the latest mention is the newest story or alert naming the entity", () => {
    const m = latestMention(
      "Dangote Refinery",
      [
        { Time: "2026-11-01T08:00:00Z", Title: "Dangote Refinery cuts petrol price - Punch", Source: "Punch", URL: "https://p.test/1" },
        { Time: "2026-11-05T08:00:00Z", Title: "Unrelated", Source: "Punch", URL: "https://p.test/2", Entities: "Dangote Refinery|NNPC" },
        { Time: "2026-11-06T08:00:00Z", Title: "MTN results", Source: "Punch", URL: "https://p.test/3" },
      ],
      [{ date: "2026-11-03", title: "Refinery probe", url: "https://p.test/4", source: "Vanguard", entities: ["Dangote Refinery"] }],
    );
    assert.deepEqual(m, { title: "Unrelated", url: "https://p.test/2", source: "Punch", date: "2026-11-05" });
    assert.equal(latestMention("Nobody Ltd", [], []), null);
  });

  test("article times in feed (RFC 822) format compare by time, not as text", () => {
    const m = latestMention(
      "Tinubu",
      [
        { Time: "Tue, 03 Nov 2026 09:00:00 GMT", Title: "Tinubu older", URL: "https://p.test/old" },
        { Time: "2026-11-02T09:00:00Z", Title: "Tinubu oldest", URL: "https://p.test/oldest" },
        { Time: "Fri, 06 Nov 2026 09:00:00 GMT", Title: "Tinubu newest", URL: "https://p.test/new" },
      ],
      [],
    );
    assert.equal(m?.url, "https://p.test/new");
    assert.equal(m?.date, "2026-11-06");
  });

  test("the inbox gets a dot only for an unread alert naming a followed entity", () => {
    const raw = [
      { date: "2026-11-04", title: "EFCC raids depot", url: "https://p.test/a", source: "Punch", entities: ["Dangote Refinery"] },
      { date: "2026-11-03", title: "MTN fined", url: "https://p.test/b", source: "Punch", entities: [] },
    ];
    const [a, b] = cleanAlerts(raw);
    assert.equal(hasNewFollowedAlert(raw, [dangote], new Set()), true);
    assert.equal(hasNewFollowedAlert(raw, [dangote], new Set([a.id])), false);
    // Matched in the headline when the alert lists no entities.
    assert.equal(hasNewFollowedAlert(raw, [mtn], new Set([a.id])), false, "'MTN Nigeria' is not in 'MTN fined'");
    assert.equal(hasNewFollowedAlert(raw, [{ slug: "mtn", name: "MTN" }], new Set([a.id])), true);
    assert.equal(hasNewFollowedAlert(raw, [{ slug: "mtn", name: "MTN" }], new Set([a.id, b.id])), false);
    assert.equal(hasNewFollowedAlert(raw, [], new Set()), false);
  });

  test("following.json keeps only what the panel and the dot match on, with the inbox's ids", () => {
    const articles = [
      { ID: 7, Time: "2026-11-05T08:00:00Z", Title: "Unrelated", Summary: "Dangote Refinery raises output.", Source: "Punch", URL: "https://p.test/2",
        Entities: "NNPC", Category: "Energy", "Risk Score": 40 },
    ];
    const alerts = [
      { date: "2026-11-04", title: "EFCC raids depot", url: "https://p.test/a", source: "Punch", entities: ["Dangote Refinery"], risk_score: 95, risk_level: "Critical", summary: "Long text.", category: "Crime" },
      { date: "2026-11-03", title: "MTN fined", url: "https://p.test/b", source: "Punch", risk_score: 70 },
    ];
    const feed = followingFeed(articles, alerts);
    assert.deepEqual(Object.keys(feed.articles[0]).sort(), ["Entities", "Source", "Summary", "Time", "Title", "URL"]);
    assert.deepEqual(Object.keys(feed.alerts[0]).sort(), ["date", "entities", "risk_level", "risk_score", "source", "title", "url"]);
    assert.deepEqual(cleanAlerts(feed.alerts), cleanAlerts(alerts));
    assert.deepEqual(latestMention("Dangote Refinery", feed.articles, feed.alerts), latestMention("Dangote Refinery", articles, alerts));
    const [a] = cleanAlerts(alerts);
    assert.equal(hasNewFollowedAlert(feed.alerts, [dangote], new Set()), true);
    assert.equal(hasNewFollowedAlert(feed.alerts, [dangote], new Set([a.id])), false);
  });
});

/* ---------- Follow by email (build side) ---------- */

const NOW = new Date("2026-11-07T07:00:00Z");
const a = (id: number, time: string, title: string, extra: Partial<Article> = {}): Article => ({ ID: id, Time: time, Title: title, Source: "Punch", URL: `https://ex.ng/${id}`, ...extra });

test("the window starts after the last emailed edition when there is one", () => {
  const items = [a(10, "2026-11-01T00:00:00Z", "old"), a(11, "2026-11-06T00:00:00Z", "edge"), a(12, "2026-11-06T09:00:00Z", "new"), a(13, "2026-11-07T06:00:00Z", "newer")];
  assert.deepEqual(editionWindow(items, { through_id: 11 }, NOW).map((x) => x.ID), [12, 13]);
});

test("without a marker the window is the last 24 hours, whatever the timestamp shape", () => {
  const items = [
    a(1, "2026-11-06T06:59:00Z", "too old"),
    a(2, "Fri, 06 Nov 2026 08:00:00 GMT", "rss time"),
    a(3, "2026-11-07 05:00:00", "runner time"),
    a(4, "", "undated"),
  ];
  for (const marker of [null, {}, { through_id: "x" }]) {
    assert.deepEqual(editionWindow(items, marker as never, NOW).map((x) => x.ID), [2, 3]);
  }
});

test("company news: named in Entities or the headline, newest first, one per link, capped", () => {
  const items = [
    a(1, "2026-11-07T01:00:00Z", "Dangote Cement raises prices - Punch", { Entities: "Dangote Cement" }),
    a(2, "2026-11-07T05:00:00Z", "Shares of Dangote Cement climb", { Source: "BusinessDay" }),
    a(3, "2026-11-07T04:00:00Z", "Dangote Cementitious things"),
    a(4, "2026-11-07T03:00:00Z", "Unrelated", { Entities: "MTN Nigeria" }),
    a(5, "2026-11-07T02:00:00Z", "Dangote Cement again", { URL: "https://ex.ng/2" }),
  ];
  const got = companyNews("Dangote Cement", items, 5);
  assert.deepEqual(got.map((s) => s.title), ["Shares of Dangote Cement climb", "Dangote Cement raises prices"]);
  assert.deepEqual(got.map((s) => s.publisher), ["BusinessDay", "Punch"]);
  assert.equal(companyNews("Dangote Cement", items, 1).length, 1);
});

test("only companies can be followed, never people", () => {
  const e = (slug: string, name: string, kind: Entity["kind"]) => ({ slug, name, kind }) as Entity;
  assert.deepEqual(
    followableCompanies([e("ada-obi", "Ada Obi", "person"), e("mtn-nigeria", "MTN Nigeria", "company")]),
    [{ slug: "mtn-nigeria", name: "MTN Nigeria" }],
  );
});
