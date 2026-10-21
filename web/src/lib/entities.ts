/**
 * Entity pages: one per holder and company in the register, plus companies
 * the news mentions often enough to be worth a page. Everything an entity
 * page shows is joined here, at build time, from the exports.
 */
import { nameKey, slugify } from "./entity-key.ts";
import type { Holding } from "./psc.ts";
import type { Article } from "./stories.ts";
import type { Contract } from "./procurement.ts";

export interface CompanyRow {
  Company?: string;
  "Mention Count"?: number;
  "Last Seen"?: string;
  "First Seen"?: string;
  Industry?: string;
  "Risk Level"?: string;
}

export interface PersonMove {
  Name?: string;
  Position?: string;
  Organization?: string;
  Event?: string;
  Date?: string;
}

export interface Entity {
  slug: string;
  name: string;
  kind: "person" | "company";
  /** As holder (person) or as the company held. */
  holdings: Holding[];
  mentions: number | null;
  industry: string;
  riskLevel: string;
  lastSeen: string;
  articles: Article[];
  moves: PersonMove[];
  contracts: Contract[];
}

export const MIN_MENTIONS_FOR_PAGE = 5;

/** Whole-word, case-insensitive match of a name inside free text. */
export function mentions(text: string, name: string): boolean {
  const n = nameKey(name);
  if (n.length < 3) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(nameKey(text));
}

function articleMentions(a: Article, name: string): boolean {
  const ents = String(a.Entities || "").split("|").map(nameKey);
  if (ents.includes(nameKey(name))) return true;
  return mentions(`${a.Title || ""} ${a.Summary || ""}`, name);
}

export function buildEntities(input: {
  holdings: Holding[];
  companies: CompanyRow[];
  people: PersonMove[];
  articles: Article[];
  contracts: Contract[];
}): Entity[] {
  const byKey = new Map<string, Entity>();
  const companyInfo = new Map(input.companies.map((c) => [nameKey(c.Company), c]));

  const ensure = (name: string, kind: Entity["kind"]): Entity | null => {
    const slug = slugify(name);
    if (!slug) return null;
    const existing = byKey.get(slug);
    if (existing) return existing;
    const info = kind === "company" ? companyInfo.get(nameKey(name)) : undefined;
    const e: Entity = {
      slug,
      name: name.trim(),
      kind,
      holdings: [],
      mentions: info?.["Mention Count"] ?? null,
      industry: info?.Industry && info.Industry !== "General" ? info.Industry : "",
      riskLevel: info?.["Risk Level"] ?? "",
      lastSeen: String(info?.["Last Seen"] ?? "").slice(0, 10),
      articles: [],
      moves: [],
      contracts: [],
    };
    byKey.set(slug, e);
    return e;
  };

  for (const h of input.holdings) {
    ensure(h.person, "person")?.holdings.push(h);
    ensure(h.company, "company")?.holdings.push(h);
  }
  for (const c of input.companies) {
    if ((c["Mention Count"] ?? 0) >= MIN_MENTIONS_FOR_PAGE && c.Company) ensure(c.Company, "company");
  }

  for (const e of byKey.values()) {
    e.articles = input.articles.filter((a) => articleMentions(a, e.name)).slice(0, 12);
    e.moves = input.people
      .filter((p) => (e.kind === "person" ? nameKey(p.Name) === nameKey(e.name) : nameKey(p.Organization) === nameKey(e.name)))
      .sort((a, b) => String(b.Date || "").localeCompare(String(a.Date || "")))
      .slice(0, 12);
    e.contracts = input.contracts
      .filter((c) => nameKey(c.agency) === nameKey(e.name) || nameKey(c.contractor) === nameKey(e.name))
      .slice(0, 12);
  }

  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}
