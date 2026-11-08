import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { weekWindow, weeklyChanges, entitySlug, entityLinks, type ChangesInput } from "./changes.ts";
import { buildEntities } from "./entities.ts";
import { groupHoldings } from "./psc.ts";

const src = (n: number) => `https://example.ng/story-${n}`;
const psc = (over: Record<string, unknown>) => ({
  "Person Name": "Ada Holder", Company: "Acme Plc", Percentage: "", Date: "2026-11-03",
  "Source URL": src(1), "Source Title": "Ada buys into Acme", Publisher: "The Punch", "Change Type": "disclosed",
  Confidence: "Full article",
  ...over,
});

const empty: ChangesInput = { records: [], companies: [], people: [], procurement: [], history: [], articles: [] };
const END = "2026-11-07";

describe("weekWindow", () => {
  test("is the seven days ending on the last run's date", () => {
    assert.deepEqual(weekWindow("2026-11-07 02:53:26"), { start: "2026-11-01", end: "2026-11-07" });
  });
  test("crosses month ends", () => {
    assert.deepEqual(weekWindow("2026-11-03"), { start: "2026-10-28", end: "2026-11-03" });
  });
});

describe("ownership records", () => {
  test("a holding first reported this week is added, with its source", () => {
    const w = weeklyChanges({ ...empty, records: [psc({ Percentage: "12%" })] }, END);
    assert.equal(w.ownership.length, 1);
    const o = w.ownership[0];
    assert.equal(o.kind, "added");
    assert.equal(o.person, "Ada Holder");
    assert.equal(o.company, "Acme Plc");
    assert.equal(o.stake, 12);
    assert.deepEqual(o.source, { url: src(1), title: "Ada buys into Acme", publisher: "The Punch" });
  });
  test("a new figure for a known holding is a stake change, with the previous figure", () => {
    const w = weeklyChanges({ ...empty, records: [
      psc({ Percentage: "10%", Date: "2026-09-01" }),
      psc({ Percentage: "15%", Date: "2026-11-04", "Source URL": src(2) }),
    ] }, END);
    assert.equal(w.ownership.length, 1);
    assert.equal(w.ownership[0].kind, "changed");
    assert.equal(w.ownership[0].previous, 10);
    assert.equal(w.ownership[0].stake, 15);
  });
  test("a repeat report of the same figure is not a change", () => {
    const w = weeklyChanges({ ...empty, records: [
      psc({ Percentage: "10%", Date: "2026-09-01" }),
      psc({ Percentage: "10%", Date: "2026-11-04" }),
    ] }, END);
    assert.equal(w.ownership.length, 0);
  });
  test("a reported exit is a removal", () => {
    const w = weeklyChanges({ ...empty, records: [
      psc({ Date: "2026-09-01", Percentage: "10%" }),
      psc({ Date: "2026-11-05", "Change Type": "lost" }),
    ] }, END);
    assert.equal(w.ownership[0].kind, "removed");
  });
  test("an exit reported with the stake sold is a removal, showing the figure reported", () => {
    const w = weeklyChanges({ ...empty, records: [
      psc({ "Person Name": "Ada Obi", Date: "2026-10-01", Percentage: "20%" }),
      psc({ "Person Name": "Ada Obi", Date: "2026-11-05", Percentage: "20%", "Change Type": "sold", "Source URL": src(2) }),
    ] }, END);
    assert.equal(w.ownership.length, 1);
    assert.equal(w.ownership[0].kind, "removed");
    assert.equal(w.ownership[0].stake, 20);
    assert.equal(w.ownership[0].previous, null);
  });
  test("an exit reported at 0% is a removal, not a stake change", () => {
    const w = weeklyChanges({ ...empty, records: [
      psc({ "Person Name": "Ada Obi", Date: "2026-10-01", Percentage: "20%" }),
      psc({ "Person Name": "Ada Obi", Date: "2026-11-05", Percentage: "0%", "Change Type": "sold", "Source URL": src(2) }),
    ] }, END);
    assert.deepEqual(w.ownership.map((o) => o.kind), ["removed"]);
  });
  test("a holding reported again after an exit is added afresh", () => {
    const w = weeklyChanges({ ...empty, records: [
      psc({ Date: "2026-10-01", Percentage: "20%" }),
      psc({ Date: "2026-10-10", Percentage: "20%", "Change Type": "sold" }),
      psc({ Date: "2026-11-05", Percentage: "20%", "Source URL": src(3) }),
    ] }, END);
    assert.deepEqual(w.ownership.map((o) => o.kind), ["added"]);
  });
  test("rows the register gate withholds never appear", () => {
    const w = weeklyChanges({ ...empty, records: [
      psc({ "Person Name": "Unsourced Person", "Source URL": "" }),
      psc({ "Person Name": "Quarantined Person", Quarantined: true }),
    ] }, END);
    assert.equal(w.ownership.length, 0);
  });
  test("reports outside the week are left out", () => {
    const w = weeklyChanges({ ...empty, records: [psc({ Date: "2026-10-31" })] }, END);
    assert.equal(w.ownership.length, 0);
  });
});

describe("first seen", () => {
  test("companies first seen this week, newest first", () => {
    const w = weeklyChanges({ ...empty, companies: [
      { Company: "Old Co", "First Seen": "2026-10-01 10:00" },
      { Company: "New Co", "First Seen": "2026-11-02 10:00" },
      { Company: "Newer Co", "First Seen": "2026-11-06 03:28" },
      { Company: "Unknown Co", "First Seen": "" },
    ] }, END);
    assert.deepEqual(w.companies.map((c) => c.name), ["Newer Co", "New Co"]);
    assert.equal(w.companies[0].date, "2026-11-06");
  });
  test("people first seen this week come from the export's First Seen, not the row date", () => {
    const w = weeklyChanges({ ...empty, people: [
      // The export keeps the newest row per (name, organisation): a recent Date, an old First Seen.
      { Name: "Olayemi Cardoso", Organization: "Central Bank of Nigeria", Date: "2026-11-04", "First Seen": "2026-09-22", Event: "other" },
      { Name: "Known Person", Organization: "Acme Plc", Date: "2026-11-03", "First Seen": "2026-11-03", Event: "other" },
      { Name: "Known Person", Organization: "Other Ltd", Date: "2026-08-01", "First Seen": "2026-08-01", Event: "other" },
      { Name: "New Person", Position: "CEO", Organization: "Acme Plc", Date: "2026-11-05", "First Seen": "2026-11-04", Event: "other" },
      { Name: "Unnamed Special Adviser", Date: "2026-11-04", "First Seen": "2026-11-04", Event: "resignation" },
    ] }, END);
    assert.deepEqual(w.people.map((p) => p.name), ["New Person"]);
    assert.equal(w.people[0].date, "2026-11-04");
    assert.equal(w.people[0].detail, "CEO, Acme Plc");
  });
  test("a person with no First Seen recorded is never claimed as new", () => {
    const w = weeklyChanges({ ...empty, people: [{ Name: "Older Export", Date: "2026-11-04", Event: "other" }] }, END);
    assert.deepEqual(w.people, []);
  });
});

describe("board moves", () => {
  test("appointments and departures this week; other mentions are not moves", () => {
    const w = weeklyChanges({ ...empty, people: [
      { Name: "Lwazi Bam", Position: "Non-Executive Director", Organization: "MTN Nigeria", Event: "appointment", Date: "2026-11-04" },
      { Name: "Ex Officer", Position: "Commissioner", Organization: "Oyo State Government", Event: "resignation", Date: "2026-11-02" },
      { Name: "Just Mentioned", Event: "other", Date: "2026-11-05" },
      { Name: "Old Move", Event: "appointment", Date: "2026-10-20" },
    ] }, END);
    assert.deepEqual(w.moves.map((m) => [m.name, m.event]), [["Lwazi Bam", "appointment"], ["Ex Officer", "departure"]]);
  });
});

describe("procurement", () => {
  test("dated awards this week, with placeholders dropped", () => {
    const w = weeklyChanges({ ...empty, procurement: [
      { Agency: "Federal Ministry of Education", Contractor: "None", Project: "National Library completion", Source: "The Punch", Date: "2026-11-07", "Amount Value": null, "Amount Currency": null },
      { Agency: "Akwa Ibom State Government", Contractor: "Julius Berger", Project: "Terminal", Source: "Premium Times Nigeria", Date: "2026-11-06", "Amount Value": 59.65e9, "Amount Currency": "NGN" },
      { Agency: "BPP", Contractor: "SON", Project: "Undated", Source: "", Date: "" },
    ] }, END);
    assert.equal(w.contracts.length, 2);
    assert.equal(w.contracts[0].agency, "Federal Ministry of Education");
    assert.equal(w.contracts[0].contractor, "");
    assert.equal(w.contracts[1].amountLabel, "₦59.65bn");
  });
  test("an extractor's 'Not specified' is no project title", () => {
    const w = weeklyChanges({ ...empty, procurement: [{ Agency: "Lagos Government", Project: "Not specified", Date: "2026-11-02" }] }, END);
    assert.equal(w.contracts[0].project, "");
  });
});

describe("source articles", () => {
  test("a line links to an article naming its entity within a day", () => {
    const article = { Title: "MTN names new directors - Premium Times Nigeria", Source: "Premium Times Nigeria", URL: src(9), Time: "2026-11-04T15:00:00Z", Entities: "MTN Nigeria|Lwazi Bam" };
    const far = { Title: "Older MTN story", URL: src(8), Time: "2026-10-20T15:00:00Z", Entities: "Lwazi Bam" };
    const w = weeklyChanges({ ...empty, articles: [far, article], people: [
      { Name: "Lwazi Bam", Organization: "MTN Nigeria", Event: "appointment", Date: "2026-11-04" },
    ] }, END);
    // The feed's " - Publisher" tail is split off, so the link reads as a headline.
    assert.deepEqual(w.moves[0].article, { url: src(9), title: "MTN names new directors", publisher: "Premium Times" });
  });
  test("a contract links only to a story about that project, not any story naming the agency", () => {
    const agency = "Central Bank of Nigeria";
    const unrelated = { Title: "Reps invite CBN governor over unpaid pensions arrears", URL: src(5), Time: "2026-11-02T10:00:00Z", Entities: agency };
    const related = { Title: "FG vows National Library project completion in 24 months", URL: src(6), Time: "2026-11-07T01:00:00Z", Entities: "Federal Ministry of Education" };
    const w = weeklyChanges({ ...empty, articles: [unrelated, related], procurement: [
      { Agency: agency, Contractor: "None", Project: "Appointment of eight agents for crude oil exports", Source: "The Eagle Online", Date: "2026-11-02" },
      { Agency: "Federal Ministry of Education", Contractor: "None", Project: "Completion of the National Library headquarters project", Source: "The Punch", Date: "2026-11-07" },
    ] }, END);
    assert.equal(w.contracts.find((c) => c.agency === agency)?.article, null);
    assert.equal(w.contracts.find((c) => c.agency !== agency)?.article?.url, src(6));
  });
  test("no article is better than a wrong one", () => {
    const w = weeklyChanges({ ...empty, articles: [{ Title: "Unrelated", URL: src(7), Time: "2026-11-04T10:00:00Z", Entities: "Someone Else" }],
      companies: [{ Company: "New Co", "First Seen": "2026-11-04 10:00" }] }, END);
    assert.equal(w.companies[0].article, null);
  });
});

describe("run activity", () => {
  test("one bar per day of the week, missing days shown as no run", () => {
    const w = weeklyChanges({ ...empty, history: [
      { date: "2026-10-31", runs: 2, articles: 50, high_risk: 3 },
      { date: "2026-11-05", runs: 2, articles: 11, high_risk: 0 },
      { date: "2026-11-07", runs: 1, articles: 6, high_risk: 1 },
    ] }, END);
    assert.equal(w.activity.length, 7);
    assert.deepEqual(w.activity[0], { date: "2026-11-01", runs: 0, articles: 0, highRisk: 0 });
    assert.deepEqual(w.activity[6], { date: "2026-11-07", runs: 1, articles: 6, highRisk: 1 });
    assert.equal(w.totals.articles, 17);
    assert.equal(w.totals.highRisk, 1);
  });
});

describe("entitySlug", () => {
  test("links only to entity pages that exist", () => {
    const slugs = new Set(["mtn-nigeria"]);
    assert.equal(entitySlug("MTN Nigeria", slugs), "mtn-nigeria");
    assert.equal(entitySlug("No Page Ltd", slugs), "");
    assert.equal(entitySlug("", slugs), "");
  });
});

describe("entityLinks", () => {
  // A person's page is about them at one company. "Tinubu" is also the kind
  // of loose word the pipeline files under Company Info, with a page of its own.
  const records = [psc({ "Person Name": "Tinubu", Company: "Acme Plc", Percentage: "12%" })];
  const people = [
    { Name: "Tinubu", Position: "Chairman", Organization: "Acme Plc", Event: "appointment", Date: "2026-11-05", "First Seen": "2026-11-05" },
    { Name: "Tinubu", Position: "President", Organization: "Federal Government", Event: "appointment", Date: "2026-11-04", "First Seen": "2026-11-04" },
  ];
  const links = entityLinks(buildEntities({
    holdings: groupHoldings(records),
    companies: [{ Company: "Tinubu", "Mention Count": 40 }],
    people,
    articles: [],
    contracts: [],
  }));
  const w = weeklyChanges({ ...empty, records, people }, END);

  test("a register holder links to their page at the company held", () => {
    const o = w.ownership[0];
    assert.equal(links.holder(o.person, o.company), "tinubu-at-acme-plc");
    assert.equal(links.holder(o.person, "Other Ltd"), "");
  });
  test("a person in a board move links only to their page at the organisation named", () => {
    const at = (org: string) => w.moves.find((m) => m.organization === org)!;
    assert.equal(links.person(at("Acme Plc").name, at("Acme Plc").organization), "tinubu-at-acme-plc");
    // Never the same-name company page, nor their page at another company.
    assert.equal(links.person(at("Federal Government").name, at("Federal Government").organization), "");
  });
  test("a person first seen links the same way, by the organisation on their first row", () => {
    assert.equal(w.people.length, 1);
    assert.equal(w.people[0].organization, "Federal Government");
    assert.equal(links.person(w.people[0].name, w.people[0].organization), "");
    assert.equal(links.person("Tinubu", ""), "");
  });
  test("companies, agencies and contractors still link by name", () => {
    assert.equal(links.company("Acme Plc"), "acme-plc");
    assert.equal(links.company("Tinubu"), "tinubu");
    assert.equal(links.company("No Page Ltd"), "");
  });
});
