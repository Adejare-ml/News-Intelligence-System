/**
 * "What changed this week": a seven-day view of AURA's records, built at
 * build time from the dated fields in the exports.
 *
 * The pipeline's changes.json only diffs one run against the last, so a
 * reader who checks in weekly would miss everything but the latest run.
 * Every list here is factual (what was recorded, and when); nothing is
 * scored or ranked, and lists run newest first.
 */
import { nameKey, slugify } from "./entity-key.ts";
import { companyKey, personKey, publicRecords, toPercent, groupHoldings, type PscRecord } from "./psc.ts";
import { toContract, known, type ProcurementRow } from "./procurement.ts";
import { cleanTitle, parseTime, publisherName } from "./stories.ts";
import type { CompanyRow, PersonMove } from "./entities.ts";

export const WEEK_DAYS = 7;

export interface ArticleRef {
  url: string;
  title: string;
  publisher: string;
}

/** The fields of a latest.json article this page uses. */
export interface ArticleLike {
  Title?: string;
  Source?: string;
  URL?: string;
  Time?: string;
  Entities?: string;
}

export interface HistoryDay {
  date: string;
  runs: number;
  articles: number;
  high_risk: number;
}

export interface ChangesInput {
  records: PscRecord[];
  companies: CompanyRow[];
  people: PersonMove[];
  procurement: ProcurementRow[];
  history: HistoryDay[];
  articles: ArticleLike[];
}

export interface OwnershipChange {
  date: string;
  kind: "added" | "changed" | "removed";
  person: string;
  company: string;
  stake: number | null;
  previous: number | null;
  source: { url: string; title: string; publisher: string };
}

export interface FirstSeen {
  date: string;
  name: string;
  detail: string;
  article: ArticleRef | null;
}

export interface BoardMove {
  date: string;
  event: "appointment" | "departure";
  name: string;
  position: string;
  organization: string;
  article: ArticleRef | null;
}

export interface ContractChange {
  date: string;
  agency: string;
  contractor: string;
  project: string;
  amountLabel: string;
  publisher: string;
  article: ArticleRef | null;
}

export interface ActivityDay {
  date: string;
  runs: number;
  articles: number;
  highRisk: number;
}

export interface WeeklyChanges {
  start: string;
  end: string;
  ownership: OwnershipChange[];
  companies: FirstSeen[];
  people: FirstSeen[];
  moves: BoardMove[];
  contracts: ContractChange[];
  activity: ActivityDay[];
  totals: { runs: number; articles: number; highRisk: number };
}

const DAY_MS = 86_400_000;

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The seven days ending on the date of the last run (its first ten characters). */
export function weekWindow(lastRun: string): { start: string; end: string } {
  const end = String(lastRun).slice(0, 10);
  return { start: addDays(end, -(WEEK_DAYS - 1)), end };
}

const dateOf = (value: unknown) => String(value ?? "").slice(0, 10);

/** Same wording as the email digest's divestment check (email_digest.py _DIVESTED). */
const DIVESTED = /lost|sold|divest|reduc|decreas|exit|ceas|resign|remov|step|left|leav|dilut/i;

/** The same holding key groupHoldings uses, so names match the entity pages. */
const holdingKey = (r: PscRecord) =>
  `${personKey(r).replace(/[^a-z0-9]/g, "")}::${companyKey(r).replace(/[^a-z0-9]/g, "")}`;

function ownershipChanges(records: PscRecord[], start: string, end: string): OwnershipChange[] {
  // Only rows the register gate publishes, whoever the caller is.
  const rows = publicRecords(records);
  const names = new Map(groupHoldings(rows).map((h) => [h.key, h]));
  const byKey = new Map<string, PscRecord[]>();
  for (const r of rows) {
    const key = holdingKey(r);
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }

  const out: OwnershipChange[] = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => dateOf(a.Date).localeCompare(dateOf(b.Date)));
    let seen = false;
    let lastStake: number | null = null;
    for (const r of sorted) {
      const date = dateOf(r.Date);
      const stake = toPercent(r.Percentage);
      const divested = DIVESTED.test(String(r["Change Type"] ?? ""));
      let kind: OwnershipChange["kind"] | null = null;
      if (divested && (stake === null || !seen)) kind = "removed";
      else if (!seen) kind = "added";
      else if (stake !== null && lastStake !== null && stake !== lastStake) kind = "changed";
      const previous = lastStake;
      seen = true;
      if (stake !== null) lastStake = stake;
      if (!kind || date < start || date > end) continue;
      const holding = names.get(key);
      out.push({
        date,
        kind,
        person: holding?.person ?? String(r["Person Name"] ?? "").trim(),
        company: holding?.company ?? String(r.Company ?? "").trim(),
        stake,
        previous: kind === "changed" ? previous : null,
        source: {
          url: String(r["Source URL"] ?? "").trim(),
          title: String(r["Source Title"] ?? "").trim(),
          publisher: String(r.Publisher ?? "").trim(),
        },
      });
    }
  }
  return out;
}

/** Words of four letters or more: enough to tell one story's subject from another's. */
const words = (text: string) => new Set(nameKey(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 4));

/**
 * An article in latest.json that lists one of the names among its entities
 * and was published within a day of the record: the closest one. A line
 * with no such article shows no link, rather than a guess.
 *
 * An agency like the CBN is named in many stories a day, so a contract also
 * needs its project to share at least two words with the headline.
 */
function articleFor(names: string[], date: string, articles: ArticleLike[], about = ""): ArticleRef | null {
  const subject = words(about);
  const wanted = new Set(names.map(nameKey).filter(Boolean));
  if (!wanted.size) return null;
  const at = Date.parse(`${date}T12:00:00Z`);
  let best: { ref: ArticleRef; gap: number } | null = null;
  for (const a of articles) {
    const url = String(a.URL ?? "").trim();
    const published = parseTime(a.Time);
    if (!/^https?:\/\//.test(url) || !published) continue;
    const gap = Math.abs(published.getTime() - at);
    if (gap > 1.5 * DAY_MS) continue;
    if (!String(a.Entities ?? "").split("|").some((e) => wanted.has(nameKey(e)))) continue;
    if (subject.size && [...words(String(a.Title ?? ""))].filter((w) => subject.has(w)).length < 2) continue;
    if (best && gap >= best.gap) continue;
    const { title, publisher } = cleanTitle(String(a.Title ?? ""), String(a.Source ?? ""));
    best = { ref: { url, title, publisher: publisher && publisherName(publisher) }, gap };
  }
  return best?.ref ?? null;
}

const newestFirst = <T extends { date: string }>(list: T[]) => list.sort((a, b) => b.date.localeCompare(a.date));

/** Placeholder people the extractor writes ("Unnamed Special Adviser") are not anyone to look up. */
const isUnnamed = (name: string) => /^unnamed\b/i.test(name);

export function weeklyChanges(input: ChangesInput, lastRun: string): WeeklyChanges {
  const { start, end } = weekWindow(lastRun);
  const inWeek = (d: string) => d >= start && d <= end;

  const companies = newestFirst(
    input.companies
      .filter((c) => c.Company && inWeek(dateOf(c["First Seen"])))
      .map((c) => {
        const date = dateOf(c["First Seen"]);
        return {
          date,
          name: String(c.Company).trim(),
          detail: c.Industry && c.Industry !== "General" ? c.Industry : "",
          article: articleFor([String(c.Company)], date, input.articles),
        };
      }),
  );

  // people.json has no first-seen field: a person's earliest dated row is when AURA first recorded them.
  const firstRow = new Map<string, PersonMove>();
  for (const p of input.people) {
    const key = nameKey(p.Name);
    const date = dateOf(p.Date);
    if (!key || !date || isUnnamed(String(p.Name))) continue;
    const prior = firstRow.get(key);
    if (!prior || date < dateOf(prior.Date)) firstRow.set(key, p);
  }
  const people = newestFirst(
    [...firstRow.values()]
      .filter((p) => inWeek(dateOf(p.Date)))
      .map((p) => {
        const date = dateOf(p.Date);
        return {
          date,
          name: String(p.Name).trim(),
          detail: [known(p.Position), known(p.Organization)].filter(Boolean).join(", "),
          article: articleFor([String(p.Name)], date, input.articles),
        };
      }),
  );

  const moves = newestFirst(
    input.people
      .filter((p) => (p.Event === "appointment" || p.Event === "resignation") && inWeek(dateOf(p.Date)))
      .map((p): BoardMove => {
        const date = dateOf(p.Date);
        return {
          date,
          event: p.Event === "appointment" ? "appointment" : "departure",
          name: String(p.Name ?? "").trim(),
          position: known(p.Position),
          organization: known(p.Organization),
          article: articleFor([String(p.Name ?? "")], date, input.articles),
        };
      }),
  );

  const contracts = newestFirst(
    input.procurement
      .map(toContract)
      .filter((c) => inWeek(c.date))
      .map((c) => ({
        date: c.date,
        agency: c.agency,
        contractor: c.contractor,
        // The extractor writes "Not specified" when a story names no project.
        project: /^not specified$/i.test(c.project) ? "" : c.project,
        amountLabel: c.amountLabel,
        publisher: c.source,
        article: articleFor([c.agency, c.contractor], c.date, input.articles, c.project),
      })),
  );

  const byDate = new Map(input.history.map((d) => [d.date, d]));
  const activity: ActivityDay[] = Array.from({ length: WEEK_DAYS }, (_, i) => {
    const date = addDays(start, i);
    const d = byDate.get(date);
    return { date, runs: d?.runs ?? 0, articles: d?.articles ?? 0, highRisk: d?.high_risk ?? 0 };
  });
  const totals = activity.reduce(
    (t, d) => ({ runs: t.runs + d.runs, articles: t.articles + d.articles, highRisk: t.highRisk + d.highRisk }),
    { runs: 0, articles: 0, highRisk: 0 },
  );

  return {
    start,
    end,
    ownership: newestFirst(ownershipChanges(input.records, start, end)),
    companies,
    people,
    moves,
    contracts,
    activity,
    totals,
  };
}

/** The entity page slug for a name, or "" when the site builds no page for it. */
export function entitySlug(name: string, slugs: Set<string>): string {
  const slug = slugify(name);
  return slug && slugs.has(slug) ? slug : "";
}
