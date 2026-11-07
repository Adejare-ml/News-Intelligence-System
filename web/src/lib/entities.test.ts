import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildEntities, isKnownCompany, type CompanyRow } from "./entities.ts";
import type { Holding } from "./psc.ts";

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
    assert.equal(isKnownCompany(bySlug(es, "aliko-dangote")), false);
  });
});
