/**
 * Ownership Finding of the Week (findings/<week>.json, written by
 * scripts/draft_finding.py and merged by the owner after a hand check).
 *
 * The draft was checked against the register when it was written, but the
 * register moves on: a row can lose its source or be quarantined later. So
 * every build checks each finding against today's register again and leaves
 * out any finding that no longer stands.
 */
import { slugify } from "./entity-key.ts";
import { companyKey, isPublic, personKey, type PscRecord } from "./psc.ts";

export interface FindingBullet {
  /** "register": a published register row; "news": an article in latest.json. */
  kind: "register" | "news";
  text: string;
  outlet: string;
  url: string;
  date: string;
  /**
   * Register bullets only: the row's canonical keys (personKey/companyKey).
   * One article can back several rows, so the link alone does not say which
   * holding the bullet claims.
   */
  record?: { person: string; company: string };
}

export interface Finding {
  week: string;
  headline: string;
  note: string;
  ref: string;
  /** Pages naming a person as an owner stay out of search results. */
  names_person: boolean;
  link: string;
  bullets: FindingBullet[];
  drafts: { linkedin: string; x: string; email: { subject: string; body: string } };
}

const WEEK = /^\d{4}-W\d{2}$/;

export const isFindingFile = (name: string) => /^\d{4}-W\d{2}\.json$/.test(name);

/**
 * Slug with one-letter words dropped, so "Quin O. Quarantined" and "Quin
 * Quarantined" compare equal, as the register gate's canonical keys do.
 * Honorifics need no handling: a whole-word match finds "Quin Quarantined"
 * inside "Alhaji Quin Quarantined".
 */
const loose = (value: unknown) =>
  slugify(value).split("-").filter((w) => w.length > 1).join("-");

/**
 * The register gate's company aliases (_COMPANY_ALIASES in
 * backend/app/services/register_quality.py): spelling -> the canonical key it
 * folds into. Mirrored so a withheld company is searched for under every
 * spelling the gate counts as the same company. tests/test_company_aliases_mirror.py
 * fails if the two tables drift apart.
 */
const COMPANY_ALIASES: Record<string, string> = {
  "dangote petroleum refinery": "dangote refinery",
  "dangote petroleum refinery and petrochemicals": "dangote refinery",
  "dangote oil refinery": "dangote refinery",
  "firstholdco": "first holdco",
  "fbn holdings": "first holdco",
  "united bank for africa uba": "united bank for africa",
  "uba": "united bank for africa",
  "seplat energy": "seplat",
  "seplat petroleum development": "seplat",
};

const aliasesOf = (key: string) =>
  Object.entries(COMPANY_ALIASES).filter(([, canon]) => canon === key).map(([spelling]) => spelling);

export function publishableFindings(findings: Finding[], register: PscRecord[]): Finding[] {
  const published = register.filter(isPublic);
  const recordKey = (url: unknown, person: unknown, company: unknown) =>
    JSON.stringify([String(url ?? "").trim(), person, company]);
  const backedRecords = new Set(published.map((r) => recordKey(r["Source URL"], personKey(r), companyKey(r))));
  const backed = (b: FindingBullet) =>
    b.kind !== "register" || (!!b.record && backedRecords.has(recordKey(b.url, b.record.person, b.record.company)));

  // People and companies the gate withholds, judged by the same canonical
  // keys it groups by; every spelling of them (name and key) is searched for.
  const publishedPeople = new Set(published.map(personKey));
  const publishedCompanies = new Set(published.map(companyKey));
  const backedNames = new Set(
    published.flatMap((r) => [r["Person Name"], r["Person Key"], r.Company, r["Company Key"]]).map(loose),
  );
  const withheld = register
    .filter((r) => !isPublic(r))
    .flatMap((r) => [
      ...(publishedPeople.has(personKey(r)) ? [] : [r["Person Name"], r["Person Key"]]),
      ...(publishedCompanies.has(companyKey(r)) ? [] : [r.Company, r["Company Key"], ...aliasesOf(companyKey(r))]),
    ])
    .map(loose)
    .filter((n) => n && !backedNames.has(n));

  return findings
    .filter((f) => f && WEEK.test(String(f.week)) && Array.isArray(f.bullets))
    .filter((f) => f.bullets.every(backed))
    .filter((f) => {
      const text = `-${loose(JSON.stringify(f))}-`;
      return !withheld.some((n) => text.includes(`-${n}-`));
    })
    .sort((a, b) => b.week.localeCompare(a.week));
}

/** "2026-W45" -> "2026-11-02": the ISO week's Monday (week 1 holds 4 January). */
export function weekStart(week: string): string {
  const [year, n] = week.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (n - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

export const whatsappHref = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;
