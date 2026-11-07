/**
 * Every entity the site builds a page for, joined once from the exports.
 * The entity page, its Markdown export and its feed all read this, so the
 * three always describe the same entities from the same published rows.
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
