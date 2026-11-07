import { test } from "node:test";
import assert from "node:assert/strict";
import { companyNews, editionWindow, followableCompanies } from "./follow.ts";
import type { Article } from "./stories.ts";
import type { Entity } from "./entities.ts";

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
