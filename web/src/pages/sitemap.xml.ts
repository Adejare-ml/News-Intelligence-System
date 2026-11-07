/** Every public page, for search engines. Built from the same lists that generate the pages. */
import * as data from "../lib/data.ts";
import { href } from "../lib/url.ts";
import { SECTIONS } from "../lib/nav.ts";
import { HEADLINE_CATEGORIES } from "../../functions/_lib/categories.ts";
import { listEditions } from "../lib/archive.ts";
import { groupHoldings } from "../lib/psc.ts";
import { toContract, type ProcurementRow } from "../lib/procurement.ts";
import { buildEntities, type CompanyRow, type PersonMove } from "../lib/entities.ts";
import { parseTime } from "../lib/stories.ts";
import { sitemapXml } from "../lib/seo.ts";

export function GET({ site }: { site?: URL }) {
  const base = site ?? new URL("https://auranews.pages.dev");
  const entities = buildEntities({
    holdings: groupHoldings(data.psc()),
    companies: data.readJson<CompanyRow[]>("companies.json", []),
    people: data.readJson<PersonMove[]>("people.json", []),
    articles: data.articles(),
    contracts: data.readJson<ProcurementRow[]>("procurement.json", []).map(toContract),
  });
  // The register and entity pages name people as owners from news reporting;
  // they carry noindex and stay out of the sitemap.
  void entities;
  // Section and category pages change with every pipeline run; an edition
  // page never changes after its run.
  const lastRun = data.reports()
    .map((r) => parseTime(r.Generated))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const loc = (p: string) => new URL(href(p), base).toString();
  const entries = [
    ...SECTIONS.map((s) => s.path).filter((p) => p !== "register/").map((p) => ({ loc: loc(p), lastmod: lastRun })),
    ...HEADLINE_CATEGORIES.map((c) => ({ loc: loc(`news/${c}/`), lastmod: lastRun })),
    ...listEditions().map((e) => ({ loc: loc(`brief/${e.slug}/`), lastmod: e.date })),
  ];
  return new Response(sitemapXml(entries), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
