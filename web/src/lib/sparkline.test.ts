import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { weeklyMentions, sparkPoints, type EntityTimeline } from "./sparkline.ts";

const timeline: EntityTimeline = {
  entities: [
    { key: "dangote refinery", label: "Dangote Refinery", points: [
      { week: "2026-09-07", mentions: 2 }, { week: "2026-10-26", mentions: 5 }, { week: "2026-11-02", mentions: 1 },
    ] },
    { key: "mtn", label: "MTN Nigeria", points: [{ week: "2026-08-03", mentions: 9 }] },
    { key: "other", label: "Other Co", points: [{ week: "2026-11-02", mentions: 3 }] },
  ],
};

describe("entity coverage sparkline", () => {
  test("nine weeks ending at the newest week in the export, gaps as zero", () => {
    const s = weeklyMentions(timeline, "dangote-refinery");
    assert.deepEqual(s?.weeks, ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
    assert.deepEqual(s?.mentions, [2, 0, 0, 0, 0, 0, 0, 5, 1]);
  });

  test("matched by the site's entity slug, so 'MTN Nigeria' finds /entity/mtn-nigeria/", () => {
    assert.equal(weeklyMentions(timeline, "dangote-refinery")?.total, 8);
    // MTN's only week is older than the window: nothing to draw.
    assert.equal(weeklyMentions(timeline, "mtn-nigeria"), null);
  });

  test("no data, no sparkline", () => {
    assert.equal(weeklyMentions(timeline, "unknown-co"), null);
    assert.equal(weeklyMentions({}, "dangote-refinery"), null);
  });

  test("points span the box, with the peak at the top", () => {
    assert.equal(sparkPoints([0, 5, 10], 100, 20), "0,20 50,10 100,0");
    assert.equal(sparkPoints([3], 100, 20), "0,0");
  });
});
