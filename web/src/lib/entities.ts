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
  /** A person's page is about them at one company (see holderSlug). */
  company: string;
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

/**
 * A person's page is a holder at one company, never a name alone: two
 * different people called Abubakar Musa at two companies get two pages,
 * so neither is shown with the other's holdings, news or board moves.
 */
export function holderSlug(person: string, company: string): string {
  return `${slugify(person)}-at-${slugify(company)}`;
}

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

  const ensure = (name: string, kind: Entity["kind"], company = ""): Entity | null => {
    const slug = kind === "person" ? holderSlug(name, company) : slugify(name);
    if (!slugify(name)) return null;
    const existing = byKey.get(slug);
    if (existing) return existing;
    const info = kind === "company" ? companyInfo.get(nameKey(name)) : undefined;
    const e: Entity = {
      slug,
      name: name.trim(),
      kind,
      company,
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

  // The canonical company each person page is about, for matching news
  // and board moves to that company rather than to the name alone.
  const companyOf = new Map<string, string>();
  for (const h of input.holdings) {
    const person = ensure(h.person, "person", h.company);
    person?.holdings.push(h);
    if (person) companyOf.set(person.slug, h.companyKey || h.company);
    ensure(h.company, "company")?.holdings.push(h);
  }
  for (const c of input.companies) {
    if ((c["Mention Count"] ?? 0) >= MIN_MENTIONS_FOR_PAGE && c.Company) ensure(c.Company, "company");
  }

  for (const e of byKey.values()) {
    const firm = companyOf.get(e.slug) ?? "";
    e.articles = input.articles
      .filter((a) => articleMentions(a, e.name) && (e.kind === "company" || articleMentions(a, firm)))
      .slice(0, 12);
    e.moves = input.people
      .filter((p) => (e.kind === "person"
        ? nameKey(p.Name) === nameKey(e.name) && mentions(String(p.Organization ?? ""), firm)
        : nameKey(p.Organization) === nameKey(e.name)))
      .sort((a, b) => String(b.Date || "").localeCompare(String(a.Date || "")))
      .slice(0, 12);
    e.contracts = input.contracts
      .filter((c) => nameKey(c.agency) === nameKey(e.name) || nameKey(c.contractor) === nameKey(e.name))
      .slice(0, 12);
  }

  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}
