/** Every public page, for search engines. Built from the same lists that generate the pages. */
import * as data from "../lib/data.ts";
import { href } from "../lib/url.ts";
import { SECTIONS } from "../lib/nav.ts";
import { listEditions } from "../lib/archive.ts";
import { groupHoldings } from "../lib/psc.ts";
import { toContract, type ProcurementRow } from "../lib/procurement.ts";
import { buildEntities, type CompanyRow, type PersonMove } from "../lib/entities.ts";

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
  const paths = [
    ...SECTIONS.map((s) => s.path).filter((p) => p !== "register/"),
    ...listEditions().map((e) => `brief/${e.slug}/`),
  ];
  const urls = paths.map((p) => `  <url><loc>${new URL(href(p), base).toString()}</loc></url>`).join("\n");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
