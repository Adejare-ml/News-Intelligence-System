import { test } from "node:test";
import assert from "node:assert/strict";
import { generatedDate, publishedDate, regionLists } from "./category-news.ts";

test("regionLists always gives both regions, in order", () => {
  const lists = regionLists({ sections: { technology: { global: [{ title: "t", url: "u", source: "s", published: "" }] } } }, "technology");
  assert.deepEqual(lists.map((l) => [l.id, l.items.length]), [["nigeria", 0], ["global", 1]]);
  assert.deepEqual(regionLists({}, "politics").map((l) => l.items.length), [0, 0]);
});

test("dates", () => {
  assert.equal(publishedDate("Fri, 06 Nov 2026 05:12:00 GMT")?.toISOString(), "2026-11-06T05:12:00.000Z");
  assert.equal(publishedDate("not a date"), null);
  assert.equal(generatedDate("2026-11-06 07:05:12")?.toISOString(), "2026-11-06T07:05:12.000Z");
  assert.equal(generatedDate(undefined), null);
});
