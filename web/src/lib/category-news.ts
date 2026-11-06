/** Shaping category_news.json for the category pages. Pure, so it can be tested. */
import type { CategoryNews, Headline } from "./data.ts";

export interface RegionList {
  id: "nigeria" | "global";
  label: string;
  items: Headline[];
}

export function regionLists(news: CategoryNews, category: string): RegionList[] {
  const section = news.sections?.[category] ?? {};
  return [
    { id: "nigeria", label: "Nigeria", items: section.nigeria ?? [] },
    { id: "global", label: "Global", items: section.global ?? [] },
  ];
}

/** Feed dates are RFC 822 strings ("Fri, 06 Nov 2026 05:12:00 GMT"); null when unreadable. */
export function publishedDate(value: string): Date | null {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

/** "2026-11-06 07:05:12" (runner time, UTC) as a Date, or null. */
export function generatedDate(value: string | undefined): Date | null {
  if (!value) return null;
  const t = Date.parse(value.replace(" ", "T") + "Z");
  return Number.isNaN(t) ? null : new Date(t);
}
