/**
 * How long things stay where. The front page shows what is current; the
 * register keeps history but moves old holdings out of the main grid, so
 * stale records never fill the space new reporting should have.
 */
export const STORY_OF_DAY_DAYS = 30;
export const FRONT_PAGE_DAYS = 60;
export const REGISTER_RECENT_DAYS = 120;

/** Whole days from an ISO date (YYYY-MM-DD) to `now`; Infinity when undated. */
export function ageInDays(iso: string, now: Date): number {
  const t = Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - t) / 864e5);
}

export function within(iso: string, days: number, now: Date): boolean {
  return ageInDays(iso, now) <= days;
}
