/**
 * Every entity the site builds a page for, joined once from the exports.
 * The entity page, its Markdown export and its feed all read this, so the
 * three always describe the same entities from the same published rows.
 */
import * as data from "./data.ts";
import { groupHoldings } from "./psc.ts";
import { toContract } from "./procurement.ts";
import { buildEntities, type Entity } from "./entities.ts";

let cached: Entity[] | null = null;

export function siteEntities(): Entity[] {
  cached ??= buildEntities({
    holdings: groupHoldings(data.psc()),
    companies: data.companies(),
    people: data.people(),
    articles: data.articles(),
    contracts: data.procurement().map(toContract),
  });
  return cached;
}
