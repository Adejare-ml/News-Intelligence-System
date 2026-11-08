/**
 * Build-time access to the pipeline's exports.
 *
 * Pages read the JSON at build time, so every number is already in the HTML:
 * nothing renders as "0" while a fetch is in flight, and no section stays
 * hidden because a request failed. Each pipeline run commits new data, and
 * that commit triggers a rebuild.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Article } from "./stories.ts";
import type { CompanyRow, PersonMove } from "./entities.ts";
import type { ProcurementRow } from "./procurement.ts";
import { publicRecords, type PscRecord } from "./psc.ts";
import { readCorrections } from "./corrections.ts";
import { hiddenNames, scrubDigest, withoutHidden, withoutHiddenLines } from "./suppressed.ts";

const DATA_DIR = process.env.AURA_DATA_DIR
  ? resolve(process.env.AURA_DATA_DIR)
  : resolve(process.cwd(), "../backend/app/static/data");

const cache = new Map<string, unknown>();

export function readJson<T>(name: string, fallback: T): T {
  if (cache.has(name)) return cache.get(name) as T;
  const path = resolve(DATA_DIR, name);
  let value: T = fallback;
  if (existsSync(path)) {
    try {
      value = JSON.parse(readFileSync(path, "utf-8")) as T;
    } catch (err) {
      console.warn(`[aura] could not parse ${name}: ${(err as Error).message}`);
    }
  } else {
    console.warn(`[aura] missing data file ${name}`);
  }
  cache.set(name, value);
  return value;
}

export function readText(name: string): string {
  const path = resolve(DATA_DIR, name);
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

/** Every file in digests/ (sent Morning Brief editions), parsed; lib/morning.ts decides which are editions. */
export function sentDigests(): unknown[] {
  const dir = resolve(DATA_DIR, "digests");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson<unknown>(`digests/${f}`, null));
}

/**
 * Names the owner has unpublished (scripts/unpublish.py). Every loader
 * below that returns rows about people or companies leaves them out, so
 * pages, search, the sitemap and the email never read them.
 */
export const hidden = () => hiddenNames(readJson<unknown>("suppressed.json", []));

export const articles = () => withoutHidden(readJson<Article[]>("latest.json", []), hidden());
/** Register rows the site may publish. Every page reads the register through this. */
export const psc = () => publicRecords(withoutHidden(readJson<PscRecord[]>("significant_control.json", []), hidden()));
export const companies = () => withoutHidden(readJson<CompanyRow[]>("companies.json", []), hidden());
export const people = () => withoutHidden(readJson<PersonMove[]>("people.json", []), hidden());
export const procurement = () => withoutHidden(readJson<ProcurementRow[]>("procurement.json", []), hidden());
/** The owner's corrections log. An entry naming an unpublished entity is left out too. */
export const corrections = () => withoutHidden(readCorrections(readJson<unknown>("corrections.json", [])), hidden());
/** The pipeline's Morning Brief edition (email_digest.json), or null. */
export const emailDigest = () => {
  const raw = readJson<Record<string, unknown> | null>("email_digest.json", null);
  return raw && typeof raw === "object" ? scrubDigest(raw, hidden()) : raw;
};

export interface GateSummary {
  checked?: number;
  published?: number;
  unsourced?: number;
  implausible?: number;
  /** Claims naming a person on headline-only reporting, held for the owner's review. */
  needs_review?: number;
}
/** Counts (never names) of register rows the validation gate kept off the site. */
export const registerQuality = () => readJson<GateSummary>("register_quality.json", {});
export const briefMarkdown = () => withoutHiddenLines(readText("report_latest.md"), hidden());

export interface FxPayload {
  generated?: string;
  latest?: Record<string, number>;
  history?: Record<string, number | string>[];
}
export const fx = () => readJson<FxPayload>("fx.json", {});
export const markets = () => readJson<FxPayload>("markets.json", {});

export interface AlertsPayload {
  generated?: string;
  window_days?: number;
  alerts?: {
    date?: string;
    title?: string;
    url?: string;
    source?: string;
    risk_score?: number;
    risk_level?: string;
    category?: string;
    summary?: string;
  }[];
}
export const alerts = (): AlertsPayload => {
  const payload = readJson<AlertsPayload>("alerts.json", {});
  return payload.alerts ? { ...payload, alerts: withoutHidden(payload.alerts, hidden()) } : payload;
};

export interface ReportRow {
  Date?: string;
  Generated?: string;
  "Total Articles"?: number;
  "High Risk"?: number;
  "Archive File"?: string;
  [key: string]: unknown;
}
export const reports = () => readJson<ReportRow[]>("reports.json", []);

export interface HistoryPayload {
  days?: { date: string; runs: number; articles: number; high_risk: number }[];
}
export const history = () => readJson<HistoryPayload>("history.json", {});

export interface WeatherPayload {
  cities?: { name: string; temp_c: number; description: string }[];
}
export const weather = () => readJson<WeatherPayload>("weather.json", {});

/** One headline from a category feed (backend/app/services/headlines.py). */
export interface Headline {
  title: string;
  url: string;
  source: string;
  published: string;
}
export interface CategoryNews {
  generated?: string;
  sections?: Record<string, { nigeria?: Headline[]; global?: Headline[] }>;
}
/** Technology and politics headlines, Nigeria and Global editions. */
export const categoryNews = (): CategoryNews => {
  const news = readJson<CategoryNews>("category_news.json", {});
  const names = hidden();
  if (!names.length || !news.sections) return news;
  // These pages are emailed too (send-brief fetches /brief/email/section/*).
  const sections = Object.fromEntries(
    Object.entries(news.sections).map(([key, s]) => [
      key,
      { ...s, nigeria: withoutHidden(s.nigeria ?? [], names), global: withoutHidden(s.global ?? [], names) },
    ]),
  );
  return { ...news, sections };
};

/** The Sunday weekly wrap (backend/app/services/weekly.py). */
export interface WeeklyWrap {
  week_start?: string;
  week_end?: string;
  generated?: string;
  markdown?: string;
}
export const weeklyWrap = (): WeeklyWrap => {
  const wrap = readJson<WeeklyWrap>("weekly_wrap.json", {});
  return wrap.markdown ? { ...wrap, markdown: withoutHiddenLines(wrap.markdown, hidden()) } : wrap;
};
