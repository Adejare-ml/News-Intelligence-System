import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatAmount, known, toContract, sortContracts, coverage } from "./procurement.ts";
import { editionFromFile, byDay } from "./archive.ts";

describe("procurement", () => {
  test("formats amounts the way the business press does", () => {
    assert.equal(formatAmount(104489205000, "USD"), "$104bn");
    assert.equal(formatAmount(41_000_000, "NGN"), "₦41m");
    assert.equal(formatAmount(4_250_000_000, "NGN"), "₦4.25bn");
    assert.equal(formatAmount(11_070_000_000_000, "NGN"), "₦11.07trn");
    assert.equal(formatAmount(100e9, "NGN"), "₦100bn");
    assert.equal(formatAmount(250e6, "GBP"), "£250m");
    assert.equal(formatAmount(20e9, "EUR"), "€20bn");
    assert.equal(formatAmount(4.5e6, "NGN"), "₦4.5m");
    assert.equal(formatAmount(null, "NGN"), "");
    assert.equal(formatAmount(0, "NGN"), "");
  });
  test("placeholders are unknown, not values", () => {
    for (const v of ["None", "", "TBD (Local Pipeline)", "N/A", null]) assert.equal(known(v), "");
    assert.equal(known(" Dangote "), "Dangote");
  });
  test("project titles lose the publisher suffix", () => {
    const c = toContract({
      Agency: "BPP", Contractor: "None", Amount: "TBD (Local Pipeline)",
      Project: "BPP, SON make certification mandatory - The Guardian Nigeria News",
      Source: "The Guardian Nigeria News", Date: "",
    });
    assert.equal(c.project, "BPP, SON make certification mandatory");
    assert.equal(c.contractor, "");
    assert.equal(c.amountLabel, "");
  });
  test("disclosed values sort first, largest first", () => {
    const list = sortContracts([
      toContract({ Agency: "A", "Amount Value": null }),
      toContract({ Agency: "B", "Amount Value": 5e9, "Amount Currency": "NGN" }),
      toContract({ Agency: "C", "Amount Value": 9e9, "Amount Currency": "NGN" }),
    ]);
    assert.deepEqual(list.map((c) => c.agency), ["C", "B", "A"]);
  });
  test("coverage measures known fields", () => {
    const list = [toContract({ Contractor: "X" }), toContract({ Contractor: "None" })];
    assert.equal(coverage(list, (c) => c.contractor), 0.5);
    assert.equal(coverage([], (c) => c.contractor), 0);
  });
});

describe("brief archive", () => {
  test("reads edition timestamps from file names", () => {
    const e = editionFromFile("report_20261021_124735.md");
    assert.equal(e?.slug, "20261021-124735");
    assert.equal(e?.date.toISOString(), "2026-10-21T12:47:35.000Z");
    assert.equal(e?.day, "2026-10-21");
    assert.equal(editionFromFile("notes.md"), null);
  });
  test("groups editions by day", () => {
    const eds = ["report_20261021_124735.md", "report_20261021_012828.md", "report_20261020_202340.md"]
      .map(editionFromFile).filter((e) => e !== null);
    const days = byDay(eds);
    assert.equal(days.length, 2);
    assert.equal(days[0].editions.length, 2);
  });
});

import { buildEntities, mentions } from "./entities.ts";
import { groupHoldings } from "./psc.ts";

describe("entities", () => {
  const holdings = groupHoldings([
    { "Person Name": "Femi Otedola", Company: "First HoldCo", Date: "2026-08-17", Percentage: "27.49%" },
    { "Person Name": "Femi Otedola", Company: "Geregu Power Plc", Date: "2026-08-01", Percentage: "" },
  ]);
  const entities = buildEntities({
    holdings,
    companies: [
      { Company: "First HoldCo", "Mention Count": 2, Industry: "Banking" },
      { Company: "NNPC", "Mention Count": 40, Industry: "General" },
      { Company: "Tiny Ltd", "Mention Count": 1 },
    ],
    people: [{ Name: "Femi Otedola", Position: "Chairman", Organization: "First HoldCo", Date: "2026-08-20" }],
    articles: [
      { Title: "Otedola raises stake in First HoldCo", Entities: "Femi Otedola|First HoldCo" },
      { Title: "NNPC posts profit", Entities: "" },
      { Title: "Unrelated NNPCX story", Entities: "" },
    ],
    contracts: [],
  });
  const by = (slug: string) => entities.find((e) => e.slug === slug);

  test("one page per holder and company, plus well-covered companies", () => {
    assert.ok(by("femi-otedola"));
    assert.ok(by("first-holdco"));
    assert.ok(by("geregu-power-plc"));
    assert.ok(by("nnpc"));
    assert.equal(by("tiny-ltd"), undefined);
  });
  test("a holder collects every holding, a company its holders", () => {
    assert.equal(by("femi-otedola")!.holdings.length, 2);
    assert.equal(by("first-holdco")!.holdings.length, 1);
    assert.equal(by("first-holdco")!.industry, "Banking");
    assert.equal(by("nnpc")!.industry, "", "'General' is not a real industry");
  });
  test("related stories match whole names only", () => {
    assert.equal(by("nnpc")!.articles.length, 1);
    assert.equal(by("femi-otedola")!.articles.length, 1);
    assert.ok(mentions("Shell and NNPC sign deal", "NNPC"));
    assert.ok(!mentions("NNPCX", "NNPC"));
    assert.ok(!mentions("anything", "AB"), "names under 3 characters never match");
  });
  test("board moves join on person name or organisation", () => {
    assert.equal(by("femi-otedola")!.moves.length, 1);
    assert.equal(by("first-holdco")!.moves.length, 1);
  });
});
