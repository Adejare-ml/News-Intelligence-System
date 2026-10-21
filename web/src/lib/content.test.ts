import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { slugify, matchesSlug, nameKey } from "./entity-key.ts";
import { cleanTitle, parseTime, rankStories, toStory, relativeTime, publisherName, isNearDuplicate, storiesInDay } from "./stories.ts";
import { parseBrief, inlineHtml, isQuietItem } from "./brief.ts";
import { nextRunAfter, isStale, editionName } from "./edition.ts";

describe("entity keys", () => {
  test("slugify is stable and idempotent", () => {
    assert.equal(slugify("First HoldCo Plc."), "first-holdco-plc");
    assert.equal(slugify("A & B"), slugify("A and B"));
    assert.equal(slugify("Société Générale"), "societe-generale");
    assert.equal(slugify(slugify("First HoldCo")), "first-holdco");
    assert.equal(slugify(""), "");
  });
  test("matching ignores spacing and case", () => {
    assert.ok(matchesSlug("  First   HoldCo ", "first-holdco"));
    assert.equal(nameKey("A  B"), "a b");
    assert.ok(!matchesSlug("", ""));
  });
});

describe("stories", () => {
  test("strips the publisher tail and keeps it as the publisher", () => {
    assert.deepEqual(cleanTitle("EFCC arraigns four - Premium Times Nigeria", "Premium Times Nigeria"),
      { title: "EFCC arraigns four", publisher: "Premium Times Nigeria" });
    const src = "The Guardian Nigeria News - Nigeria and World News";
    assert.equal(cleanTitle(`Airports listed - ${src}`, src).title, "Airports listed");
    assert.equal(cleanTitle("EFCC arrests businessman for $120m |").title, "EFCC arrests businessman for $120m");
    const long = "Senate passes bill - a move critics say will raise prices for everyone";
    assert.equal(cleanTitle(long).title, long);
  });
  test("readable publisher names", () => {
    assert.equal(publisherName("sunnewsonline"), "The Sun");
    assert.equal(publisherName("Some New Outlet"), "Some New Outlet");
    assert.equal(publisherName(""), "Unknown source");
  });
  test("parses the three timestamp shapes as UTC", () => {
    assert.equal(parseTime("2026-10-21 00:37:55")?.toISOString(), "2026-10-21T00:37:55.000Z");
    assert.equal(parseTime("2026-10-20T05:27:25Z")?.toISOString(), "2026-10-20T05:27:25.000Z");
    assert.equal(parseTime("Wed, 21 Oct 2026 08:00:00 GMT")?.toISOString(), "2026-10-21T08:00:00.000Z");
    assert.equal(parseTime("not a date"), null);
    assert.equal(parseTime(""), null);
  });
  test("ranking favours important, fresh stories and drops duplicates", () => {
    const now = new Date("2026-10-21T12:00:00Z");
    const ranked = rankStories([
      { ID: 1, Title: "Old but big", Time: "2026-10-15T00:00:00Z", Importance: 90, "Risk Score": 80 },
      { ID: 2, Title: "Fresh and big", Time: "2026-10-21T10:00:00Z", Importance: 85, "Risk Score": 70 },
      { ID: 3, Title: "Fresh and big", Time: "2026-10-21T09:00:00Z", Importance: 85, "Risk Score": 70 },
      { ID: 4, Title: "Fresh but minor", Time: "2026-10-21T11:00:00Z", Importance: 20, "Risk Score": 10 },
    ], now, 5);
    assert.equal(ranked[0].title, "Fresh and big");
    assert.equal(ranked.filter((s) => s.title === "Fresh and big").length, 1);
  });
  test("a separator left behind by the publisher tail is dropped", () => {
    assert.equal(cleanTitle("EFCC arrests businessman for $120m | - The Eagle Online", "The Eagle Online").title,
      "EFCC arrests businessman for $120m");
  });
  test("near-duplicate headlines from two outlets count once", () => {
    assert.ok(isNearDuplicate("FG pays N4.25bn to 600 more former Nigeria Airways workers", "FG pays fresh N4.25bn to 600 ex-Nigeria Airways workers"));
    assert.ok(isNearDuplicate("Keyamo approves design for Lagos airport monorail", "Keyamo approves design for Lagos Airport monorail project"));
    assert.ok(!isNearDuplicate("FG, Bi-Courtney end 18-year MMA2 dispute", "FAAN begins earning MMA2 revenue as 20-year dispute with Bi-Courtney ends"));
    const now = new Date("2026-10-21T12:00:00Z");
    const ranked = rankStories([
      { ID: 1, Title: "Keyamo approves design for Lagos airport monorail", Time: "2026-10-21T10:00:00Z" },
      { ID: 2, Title: "Keyamo approves design for Lagos Airport monorail project", Time: "2026-10-21T09:00:00Z" },
    ], now);
    assert.equal(ranked.length, 1);
  });
  test("one definition of stories today: distinct stories in the last 24 hours", () => {
    const at = new Date("2026-10-21T12:00:00Z");
    assert.equal(storiesInDay([
      { Title: "Keyamo approves design for Lagos airport monorail", Time: "2026-10-21T10:00:00Z" },
      { Title: "Keyamo approves design for Lagos Airport monorail project", Time: "2026-10-21T09:00:00Z" },
      { Title: "Customs targets N11trn revenue", Time: "2026-10-20T13:00:00Z" },
      { Title: "Old story", Time: "2026-10-19T10:00:00Z" },
    ], at), 2);
  });
  test("covers are deterministic and risk-toned", () => {
    const a = toStory({ Title: "EFCC arraigns four", Category: "Legal", "Risk Score": 80 });
    const b = toStory({ Title: "EFCC arraigns four", Category: "Legal", "Risk Score": 80 });
    assert.deepEqual(a.cover, b.cover);
    assert.equal(a.cover.tone, "crimson");
    assert.equal(a.cover.glyph, "EFCC");
  });
  test("relative time", () => {
    const now = new Date("2026-10-21T12:00:00Z");
    assert.equal(relativeTime(new Date("2026-10-21T11:30:00Z"), now), "30m ago");
    assert.equal(relativeTime(new Date("2026-10-21T09:00:00Z"), now), "3h ago");
    assert.equal(relativeTime(new Date("2026-10-20T08:00:00Z"), now), "Yesterday");
    assert.equal(relativeTime(null, now), "");
  });
});

describe("brief", () => {
  const md = [
    "# PSC & Company Daily Intelligence Report",
    "**Generated on:** 2026-10-21 12:47:35 (UTC)",
    "**Run Window:** 2026-10-21, all runs to 12:47 (run 2 of the day)",
    "",
    "## Summary Statistics",
    "- **Total Articles Processed:** 25",
    "- **High Risk Signals:** 1",
    "",
    "---",
    "Report Date: 2026-10-21",
    "",
    "### Key Developments",
    "- **NCC enforces a new device policy** that may raise prices. ([The Guardian Nigeria News](https://news.example/a))  ",
    "- **Customs targets revenue** and more.",
    "",
    "### Beneficial Ownership & PSC Disclosures",
    "- No PSC or significant-control disclosures were identified.",
    "",
    "---",
    "*Report compiled cloud-based by AURA.*",
  ].join("\n");

  test("reads metadata, stats and sections", () => {
    const b = parseBrief(md);
    assert.equal(b.title, "PSC & Company Daily Intelligence Report");
    assert.equal(b.generated, "2026-10-21 12:47:35 (UTC)");
    assert.deepEqual(b.stats[0], { label: "Total Articles Processed", value: "25" });
    assert.deepEqual(b.sections.map((s) => s.id), ["key-developments", "beneficial-ownership-and-psc-disclosures"]);
  });
  test("splits a bullet into lead, sentence and source", () => {
    const item = parseBrief(md).sections[0].items[0];
    assert.equal(item.lead, "NCC enforces a new device policy");
    assert.equal(item.rest, "that may raise prices.");
    assert.deepEqual(item.source, { name: "The Guardian Nigeria News", url: "https://news.example/a" });
  });
  test("tolerates a doubled closing paren after the source link", () => {
    const item = parseBrief("### Key Developments\n- **Pledge made** in two waves. ([Punch Newspapers](https://news.example/b)))  ").sections[0].items[0];
    assert.deepEqual(item.source, { name: "Punch Newspapers", url: "https://news.example/b" });
    assert.equal(item.rest, "in two waves.");
  });
  test("a headline the pipeline restored from the source title reads cleanly", () => {
    const item = parseBrief("### Key Developments\n- **FAAN begins earning MMA2 revenue**. The authority has begun receiving revenue. ([Premium Times](https://news.example/c))").sections[0].items[0];
    assert.equal(item.lead, "FAAN begins earning MMA2 revenue");
    assert.equal(item.rest, "The authority has begun receiving revenue.");
  });
  test("recognises quiet items", () => {
    assert.ok(isQuietItem(parseBrief(md).sections[1].items[0]));
  });
  test("escapes HTML and drops non-http links", () => {
    assert.ok(!inlineHtml("<script>alert(1)</script>").includes("<script>"));
    assert.ok(!inlineHtml("[x](javascript:alert(1))").includes("javascript:"));
    assert.ok(inlineHtml("[x](https://a.example)").includes('href="https://a.example"'));
  });
});

describe("edition clock", () => {
  test("next run follows the UTC schedule and wraps to tomorrow", () => {
    assert.equal(nextRunAfter(new Date("2026-10-21T12:47:00Z")).toISOString(), "2026-10-21T13:00:00.000Z");
    assert.equal(nextRunAfter(new Date("2026-10-21T23:30:00Z")).toISOString(), "2026-10-22T07:00:00.000Z");
  });
  test("stale after a missed run", () => {
    const now = new Date("2026-10-21T22:00:00Z");
    assert.ok(!isStale(new Date("2026-10-21T17:05:00Z"), now));
    assert.ok(isStale(new Date("2026-10-21T07:05:00Z"), now));
    assert.ok(isStale(null, now));
  });
  test("edition names by Lagos hour", () => {
    assert.equal(editionName(new Date("2026-10-21T07:10:00Z")), "Morning edition");
    assert.equal(editionName(new Date("2026-10-21T13:10:00Z")), "Afternoon edition");
    assert.equal(editionName(new Date("2026-10-21T22:10:00Z")), "Evening edition");
  });
});
