/**
 * The edition clock: when the data was last refreshed and when the next
 * pipeline run is due. Runs are scheduled in .github/workflows/news_scheduler.yml
 * at 07:00, 13:00, 17:00 and 23:00 UTC (08:00, 14:00, 18:00, 00:00 in Lagos).
 */

export const RUN_HOURS_UTC = [7, 13, 17, 23];
/** A gap longer than the longest scheduled interval (8h) plus slack means a run was missed. */
export const STALE_AFTER_HOURS = 9;

export function nextRunAfter(date: Date): Date {
  for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
    for (const hour of RUN_HOURS_UTC) {
      const candidate = new Date(Date.UTC(
        date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + dayOffset, hour, 0, 0));
      if (candidate.getTime() > date.getTime()) return candidate;
    }
  }
  return new Date(date.getTime() + 6 * 36e5);
}

export function isStale(lastUpdated: Date | null, now: Date): boolean {
  if (!lastUpdated) return true;
  return (now.getTime() - lastUpdated.getTime()) / 36e5 > STALE_AFTER_HOURS;
}

const lagos = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", ...opts });

export function lagosTime(date: Date): string {
  return lagos({ hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

export function lagosDate(date: Date): string {
  return lagos({ weekday: "long", day: "numeric", month: "long" }).format(date);
}

export function lagosShortDate(date: Date): string {
  return lagos({ day: "numeric", month: "short", year: "numeric" }).format(date);
}

/** Morning / afternoon / evening edition, by Lagos hour. */
export function editionName(date: Date): string {
  const hour = Number(lagos({ hour: "2-digit", hour12: false }).format(date));
  if (hour >= 5 && hour < 12) return "Morning edition";
  if (hour >= 12 && hour < 17) return "Afternoon edition";
  return "Evening edition";
}
