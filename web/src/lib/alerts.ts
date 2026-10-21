/**
 * Alerts for the notification inbox: alerts.json cleaned into short,
 * readable items with stable ids (so "read" survives rebuilds).
 */
import { cleanTitle, publisherName, riskLevelFor, type Story } from "./stories.ts";

export interface RawAlert {
  date?: string;
  title?: string;
  url?: string;
  source?: string;
  risk_score?: number;
  risk_level?: string;
}

export interface Alert {
  id: string;
  date: string;
  title: string;
  url: string;
  source: string;
  score: number;
  level: Story["riskLevel"];
}

/** FNV-1a of the URL, base36: short, stable, and safe in localStorage. */
export function alertId(url: string): string {
  let h = 2166136261;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function cleanAlerts(raw: RawAlert[], limit = 30): Alert[] {
  const seen = new Set<string>();
  const out: Alert[] = [];
  for (const a of raw || []) {
    const url = String(a.url || "").trim();
    const { title, publisher } = cleanTitle(String(a.title || ""), String(a.source || ""));
    const key = url || title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    const score = Number(a.risk_score) || 0;
    out.push({
      id: alertId(key),
      date: String(a.date || "").slice(0, 10),
      title,
      url,
      source: publisherName(publisher || String(a.source || "")),
      score,
      // The pipeline's own level wins, so the inbox agrees with the brief and
      // the register; the score only decides when no level was stored.
      level: riskLevelFor(score, a.risk_level),
    });
  }
  return out
    .sort((a, b) => b.date.localeCompare(a.date) || b.score - a.score)
    .slice(0, limit);
}
