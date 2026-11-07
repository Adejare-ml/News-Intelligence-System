import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseFollows, toggleFollow, latestMention, hasNewFollowedAlert } from "./follow.ts";
import { cleanAlerts } from "./alerts.ts";

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
});
