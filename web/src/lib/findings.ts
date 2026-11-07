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
import { isPublic, type PscRecord } from "./psc.ts";

export interface FindingBullet {
  /** "register": a published register row; "news": an article in latest.json. */
  kind: "register" | "news";
  text: string;
  outlet: string;
  url: string;
  date: string;
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

export function publishableFindings(findings: Finding[], register: PscRecord[]): Finding[] {
  const published = register.filter(isPublic);
  const backedUrls = new Set(published.map((r) => String(r["Source URL"]).trim()));
  const backedNames = new Set(published.flatMap((r) => [slugify(r["Person Name"]), slugify(r.Company)]));
  // Names that appear only in rows the gate withholds must not reach a page.
  const withheld = register
    .filter((r) => !isPublic(r))
    .flatMap((r) => [r["Person Name"], r.Company])
    .filter((n) => slugify(n) && !backedNames.has(slugify(n)));

  return findings
    .filter((f) => f && WEEK.test(String(f.week)) && Array.isArray(f.bullets))
    .filter((f) => f.bullets.every((b) => b.kind !== "register" || backedUrls.has(b.url)))
    .filter((f) => {
      const text = `-${slugify(JSON.stringify(f))}-`;
      return !withheld.some((n) => text.includes(`-${slugify(n)}-`));
    })
    .sort((a, b) => b.week.localeCompare(a.week));
}

export const whatsappHref = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;
