/**
 * Build-time access to the pipeline's exports.
 *
 * Pages read the JSON at build time, so every number is already in the HTML:
 * nothing renders as "0" while a fetch is in flight, and no section stays
 * hidden because a request failed. Each pipeline run commits new data, and
 * that commit triggers a rebuild.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Article } from "./stories.ts";
import type { PscRecord } from "./psc.ts";

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

export const articles = () => readJson<Article[]>("latest.json", []);
export const psc = () => readJson<PscRecord[]>("significant_control.json", []);
export const briefMarkdown = () => readText("report_latest.md");

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
export const alerts = () => readJson<AlertsPayload>("alerts.json", {});

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
