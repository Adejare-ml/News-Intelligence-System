/**
 * Every entity page's data, built once per build: the entity pages and the
 * Follow by email pages must agree on which companies exist, and both read
 * the register only through data.psc() (the publishing gate).
 */
import * as data from "./data.ts";
import { groupHoldings } from "./psc.ts";
import { toContract, type ProcurementRow } from "./procurement.ts";
import { buildEntities, type CompanyRow, type Entity, type PersonMove } from "./entities.ts";

let cached: Entity[] | null = null;

export function siteEntities(): Entity[] {
  cached ??= buildEntities({
    holdings: groupHoldings(data.psc()),
    companies: data.readJson<CompanyRow[]>("companies.json", []),
    people: data.readJson<PersonMove[]>("people.json", []),
    articles: data.articles(),
    contracts: data.readJson<ProcurementRow[]>("procurement.json", []).map(toContract),
  });
  return cached;
}
