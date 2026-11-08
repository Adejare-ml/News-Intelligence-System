import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildEntities, holderSlug } from "./entities.ts";
import { groupHoldings } from "./psc.ts";

const musa = (company: string, key: string) => ({
  "Person Name": "Abubakar Musa", "Person Key": "abubakar musa", Company: company, "Company Key": key,
  Date: "2026-09-01", Source: "extracted", Confidence: "Full article", "Source URL": "https://punchng.com/r/",
});

describe("Person pages are per holder and company", () => {
  test("the slug names the company too", () => {
    assert.equal(holderSlug("Abubakar Musa", "Kano Flour Mills Plc"), "abubakar-musa-at-kano-flour-mills-plc");
  });
  test("two people sharing a name at different companies get two pages", () => {
    const entities = buildEntities({
      holdings: groupHoldings([musa("Kano Flour Mills", "kano flour mills"), musa("Sokoto Cement", "sokoto cement")]),
      companies: [],
      people: [
        { Name: "Abubakar Musa", Position: "Chairman", Organization: "Kano Flour Mills Plc", Date: "2026-09-02" },
        { Name: "Abubakar Musa", Position: "Director", Organization: "Sokoto Cement Ltd", Date: "2026-09-03" },
      ],
      articles: [
        { Title: "Abubakar Musa takes Kano Flour Mills chair", Summary: "" },
        { Title: "Abubakar Musa joins Sokoto Cement board", Summary: "" },
      ],
      contracts: [],
    });
    const people = entities.filter((e) => e.kind === "person");
    assert.deepEqual(people.map((e) => e.slug).sort(), [
      "abubakar-musa-at-kano-flour-mills", "abubakar-musa-at-sokoto-cement",
    ]);
    const kano = people.find((e) => e.slug.endsWith("kano-flour-mills"))!;
    assert.equal(kano.holdings.length, 1);
    assert.deepEqual(kano.moves.map((m) => m.Position), ["Chairman"]);
    assert.deepEqual(kano.articles.map((a) => a.Title), ["Abubakar Musa takes Kano Flour Mills chair"]);
  });
});
