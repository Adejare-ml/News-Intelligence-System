/**
 * GET /api/stats   Authorization: Bearer <BRIEF_SEND_SECRET>
 *
 * Counts for the owner: subscribers by status, and among active readers
 * (confirmed, not paused) by category, region and frequency; sign-ups per
 * ISO week; and the last 14 sends. Counts only: no address ever leaves D1.
 */
import { authorised, json, type Ctx } from "../_lib/http.ts";
import { CATEGORIES, FREQUENCIES, REGIONS, headlineCategories, type Prefs } from "../_lib/categories.ts";
import { sendLog, subscriberStore } from "../_lib/subscribers.ts";

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

export function summarise(rows: { status: string; paused: boolean; created_at: string; prefs: Prefs }[], weeks = 12) {
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
