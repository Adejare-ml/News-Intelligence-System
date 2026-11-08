/**
 * The coverage sparkline on entity pages: weekly mentions from
 * entity_timeline.json, drawn as inline SVG at build time (no script).
 */
import { matchesSlug } from "./entity-key.ts";

export interface EntityTimeline {
  entities?: { key?: string; label?: string; points?: { week: string; mentions: number }[] }[];
}

export interface WeeklySeries {
  weeks: string[];
  mentions: number[];
  total: number;
}

export const SPARK_WEEKS = 9;

const DAY_MS = 864e5;

/**
 * The last `weeks` ISO weeks for one entity. The window ends at the newest
 * week anywhere in the export (not the build date), so every page shares
 * one window and a quiet entity shows its quiet weeks as zeros. Returns
 * null when the entity has no mention inside the window: no empty chart.
 */
export function weeklyMentions(timeline: EntityTimeline, slug: string, weeks = SPARK_WEEKS): WeeklySeries | null {
  const all = timeline.entities ?? [];
  const latest = all.flatMap((e) => e.points ?? []).reduce((max, p) => (p.week > max ? p.week : max), "");
  // The pipeline's keys drop words like "Nigeria"; the label is the name the site slugs.
  const entity = all.find((e) => matchesSlug(e.label, slug));
  if (!latest || !entity) return null;

  const end = Date.parse(`${latest}T00:00:00Z`);
  const window = Array.from({ length: weeks }, (_, i) => new Date(end - (weeks - 1 - i) * 7 * DAY_MS).toISOString().slice(0, 10));
  const byWeek = new Map((entity.points ?? []).map((p) => [p.week, p.mentions]));
  const mentions = window.map((w) => byWeek.get(w) ?? 0);
  const total = mentions.reduce((a, b) => a + b, 0);
  return total ? { weeks: window, mentions, total } : null;
}

/** SVG polyline points: x spread across the width, the busiest week at the top. */
export function sparkPoints(values: number[], width: number, height: number): string {
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return values.map((v, i) => `${round(i * step)},${round(height - (v / max) * height)}`).join(" ");
}
