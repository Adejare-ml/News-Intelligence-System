import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildEntities, holderSlug, isKnownCompany, type CompanyRow } from "./entities.ts";
import { groupHoldings, type Holding } from "./psc.ts";

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

const build = (companies: CompanyRow[], holdings: Holding[] = []) =>
  buildEntities({ holdings, companies, people: [], articles: [], contracts: [] });
const bySlug = (es: ReturnType<typeof build>, slug: string) => es.find((e) => e.slug === slug)!;

describe("isKnownCompany", () => {
  test("a name the news mentions often is not a company just for that", () => {
    // The pipeline files people and loose words such as "Tinubu" and "AI"
    // under Company Info with Industry "General".
    const es = build([
      { Company: "Tinubu", "Mention Count": 40, Industry: "General" },
      { Company: "AI", "Mention Count": 9, Industry: "General" },
    ]);
    assert.equal(isKnownCompany(bySlug(es, "tinubu")), false);
    assert.equal(isKnownCompany(bySlug(es, "ai")), false);
  });

  test("a real industry or a legal suffix marks a company", () => {
    const es = build([
      { Company: "MTN Nigeria", "Mention Count": 9, Industry: "Telecoms" },
      { Company: "Zenith Bank Plc", "Mention Count": 9, Industry: "General" },
      { Company: "NNPC Limited", "Mention Count": 9, Industry: "General" },
    ]);
    assert.equal(isKnownCompany(bySlug(es, "mtn-nigeria")), true);
    assert.equal(isKnownCompany(bySlug(es, "zenith-bank-plc")), true);
    assert.equal(isKnownCompany(bySlug(es, "nnpc-limited")), true);
  });

  test("the company side of a register holding is a company; the holder is not", () => {
    const h = { person: "Aliko Dangote", company: "Acme" } as Holding;
    const es = build([], [h]);
    assert.equal(isKnownCompany(bySlug(es, "acme")), true);
    assert.equal(isKnownCompany(bySlug(es, "aliko-dangote-at-acme")), false);
  });
});
