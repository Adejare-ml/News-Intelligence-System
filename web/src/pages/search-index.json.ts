/**
 * The ⌘K index, generated at build time and fetched on first open.
 * Compact keys (see lib/search.ts Entry) keep it small.
 */
import * as data from "../lib/data.ts";
import { href } from "../lib/url.ts";
import { SECTIONS } from "../lib/nav.ts";
import { groupHoldings, describeHolding } from "../lib/psc.ts";
import { toStory } from "../lib/stories.ts";
import { toContract, type ProcurementRow } from "../lib/procurement.ts";
import { buildEntities, type CompanyRow, type PersonMove } from "../lib/entities.ts";
import { listEditions } from "../lib/archive.ts";
import { lagosDate, lagosTime } from "../lib/edition.ts";
import type { Entry } from "../lib/search.ts";

export function GET() {
  const holdings = groupHoldings(data.psc());
  const entities = buildEntities({
    holdings,
    companies: data.readJson<CompanyRow[]>("companies.json", []),
    people: data.readJson<PersonMove[]>("people.json", []),
    articles: data.articles(),
    contracts: data.readJson<ProcurementRow[]>("procurement.json", []).map(toContract),
  });

  const entries: Entry[] = [
    ...SECTIONS.map((s) => ({ t: "page" as const, l: s.label, s: "Section", u: href(s.path) })),
    ...entities.map((e) => ({
      t: "entity" as const,
      l: e.name,
      s: e.kind === "person" ? "Person" : `Company${e.industry ? ` · ${e.industry}` : ""}`,
      u: href(`entity/${e.slug}/`),
    })),
    ...holdings.map((h) => ({
      t: "holding" as const,
      l: `${h.person} → ${h.company}`,
      s: describeHolding(h),
      u: href(`register/?q=${encodeURIComponent(h.person)}`),
      k: `${h.person} ${h.company} ${h.vehicle}`.toLowerCase(),
    })),
    ...data.articles().map(toStory).filter((s) => s.title).map((s) => ({
      t: "story" as const,
      l: s.title,
      s: `${s.publisher} · ${s.category}`,
      u: s.url,
      k: s.entities.join(" ").toLowerCase(),
    })),
    ...listEditions().slice(0, 60).map((e) => ({
      t: "brief" as const,
      l: `Brief of ${lagosDate(e.date)}`,
      s: `${lagosTime(e.date)} Lagos`,
      u: href(`brief/${e.slug}/`),
    })),
  ];

  return new Response(JSON.stringify(entries), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
