/**
 * GET /api/stats   Authorization: Bearer <BRIEF_SEND_SECRET>
 *
 * Counts for the owner: subscribers by status, and among active readers
 * (confirmed, not paused) by category, region and frequency; sign-ups per
 * ISO week; how many sign-ups confirm, and how fast; and the last 14 sends.
 * Counts only: no address ever leaves D1.
 */
import { authorised, json, type Ctx } from "../_lib/http.ts";
import { CATEGORIES, FREQUENCIES, REGIONS, headlineCategories } from "../_lib/categories.ts";
import { sendLog, subscriberStore, type StatRow } from "../_lib/subscribers.ts";

/** Monday of the ISO week a timestamp falls in, as YYYY-MM-DD (UTC). */
export function weekOf(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

const zeroes = <T extends string>(ids: readonly T[]) => Object.fromEntries(ids.map((id) => [id, 0])) as Record<T, number>;

/** A pending sign-up younger than this may still confirm (the reminder goes at 48-72h), so it is not counted yet. */
export const CONFIRM_WAIT_HOURS = 72;

const hoursBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * rate: of the sign-ups that have had their chance (every row except pending
 * ones younger than CONFIRM_WAIT_HOURS), the share that ever confirmed
 * (confirmed_at set, whether or not they have since unsubscribed). `counted`
 * is that denominator. median_hours_to_confirm: from sign-up to confirmation,
 * over everyone who confirmed. Both null when there is nothing to measure.
 * A reader who unsubscribes and signs up again counts once, for the latest
 * sign-up: reopen() restarts created_at and clears confirmed_at.
 */
export function confirmationStats(rows: Pick<StatRow, "status" | "created_at" | "confirmed_at">[], now: Date) {
  const counted = rows.filter((r) => r.status !== "pending" || hoursBetween(r.created_at, now.toISOString()) >= CONFIRM_WAIT_HOURS);
  const confirmed = counted.filter((r) => r.confirmed_at);
  const hours = rows
    .filter((r) => r.confirmed_at)
    .map((r) => hoursBetween(r.created_at, r.confirmed_at!))
    .filter((h) => Number.isFinite(h) && h >= 0);
  const mid = median(hours);
  return {
    rate: counted.length ? Math.round((confirmed.length / counted.length) * 1000) / 1000 : null,
    counted: counted.length,
    median_hours_to_confirm: mid === null ? null : Math.round(mid * 10) / 10,
  };
}

export function summarise(rows: StatRow[], weeks = 12, now = new Date()) {
  const status: Record<string, number> = { pending: 0, confirmed: 0, unsubscribed: 0 };
  const active = rows.filter((r) => r.status === "confirmed" && !r.paused);
  const byCategory = zeroes(CATEGORIES.map((c) => c.id));
  // Region only means something for readers with a headline category.
  const byRegion = zeroes(REGIONS.map((r) => r.id));
  const byFrequency = zeroes(FREQUENCIES.map((f) => f.id));
  const signups: Record<string, number> = {};

  for (const r of rows) {
    status[r.status] = (status[r.status] ?? 0) + 1;
    const week = weekOf(r.created_at);
    if (week) signups[week] = (signups[week] ?? 0) + 1;
  }
  for (const r of active) {
    for (const c of r.prefs.categories) byCategory[c]++;
    if (headlineCategories(r.prefs).length) byRegion[r.prefs.region]++;
    byFrequency[r.prefs.frequency]++;
  }
  const recentWeeks = Object.keys(signups).sort().slice(-weeks);
  return {
    total: rows.length,
    status,
    paused: rows.filter((r) => r.status === "confirmed" && r.paused).length,
    active: {
      total: active.length,
      by_category: byCategory,
      by_region: byRegion,
      by_frequency: byFrequency,
    },
    signups_by_week: recentWeeks.map((week) => ({ week, count: signups[week] })),
    confirmation: confirmationStats(rows, now),
  };
}

export async function onRequestGet({ request, env }: Ctx): Promise<Response> {
  if (!env.BRIEF_SEND_SECRET) return json({ error: "Stats need BRIEF_SEND_SECRET to be set." }, 503);
  if (!authorised(request, env)) return json({ error: "Not authorised." }, 401);
  if (!env.DB) return json({ error: "Subscriber database (DB) is not bound." }, 503);
  const rows = await subscriberStore(env.DB).statRows();
  const sends = await sendLog(env.DB).recent(14);
  return json({ generated: new Date().toISOString(), ...summarise(rows), sends });
}

export function onRequest(): Response {
  return json({ error: "Use GET." }, 405, { Allow: "GET" });
}
