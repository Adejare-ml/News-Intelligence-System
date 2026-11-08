/**
 * What a Morning Brief reader can choose: categories, the region their
 * headline categories come from, and how often they hear from us.
 *
 * One list, shared by the sign-up form, the preferences page, the Pages
 * Functions and the email pages, so a category added here appears
 * everywhere. Business is AURA's own ownership brief; the others are
 * headline sections built by the pipeline (category_news.json).
 *
 * Sports and Entertainment were offered once and cut. Rows that still name
 * them read without them (parseCategories keeps only ids listed here), and
 * a row left with nothing falls back to Business (prefsFromRow).
 */

export const CATEGORIES = [
  { id: "business", label: "Business", blurb: "Ownership changes, board moves and public contracts" },
  { id: "technology", label: "Technology", blurb: "Tech, startups, telecoms and AI" },
  { id: "politics", label: "Politics", blurb: "Government, elections and policy" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

/** Categories built from headline feeds (everything but Business). */
export const HEADLINE_CATEGORIES = CATEGORIES.filter((c) => c.id !== "business").map((c) => c.id) as Exclude<CategoryId, "business">[];
export type HeadlineCategory = (typeof HEADLINE_CATEGORIES)[number];

export const REGIONS = [
  { id: "nigeria", label: "Nigeria" },
  { id: "global", label: "Global" },
  { id: "both", label: "Nigeria + Global" },
] as const;
export type Region = (typeof REGIONS)[number]["id"];
/** The editions a feed is published in. "both" means each of these. */
export type Edition = Exclude<Region, "both">;

export const FREQUENCIES = [
  { id: "daily", label: "Every morning", when: "08:00 Lagos" },
  { id: "weekly", label: "Once a week", when: "Mondays, 08:00 Lagos" },
] as const;
export type Frequency = (typeof FREQUENCIES)[number]["id"];

export interface Prefs {
  categories: CategoryId[];
  region: Region;
  frequency: Frequency;
}

export const DEFAULT_PREFS: Prefs = { categories: ["business"], region: "nigeria", frequency: "daily" };

const CATEGORY_IDS = new Set<string>(CATEGORIES.map((c) => c.id));
const REGION_IDS = new Set<string>(REGIONS.map((r) => r.id));
const FREQUENCY_IDS = new Set<string>(FREQUENCIES.map((f) => f.id));

export const categoryLabel = (id: string): string => CATEGORIES.find((c) => c.id === id)?.label ?? id;

/** Accepts an array, a comma-separated string or a single id; keeps known ids, in display order, once each. */
export function parseCategories(value: unknown): CategoryId[] {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  const wanted = new Set(raw.map((v) => String(v).trim().toLowerCase()).filter((v) => CATEGORY_IDS.has(v)));
  return CATEGORIES.map((c) => c.id).filter((id) => wanted.has(id));
}

export function parseRegion(value: unknown): Region | null {
  const v = String(value ?? "").trim().toLowerCase();
  return REGION_IDS.has(v) ? (v as Region) : null;
}

export function parseFrequency(value: unknown): Frequency | null {
  const v = String(value ?? "").trim().toLowerCase();
  return FREQUENCY_IDS.has(v) ? (v as Frequency) : null;
}

/**
 * Preferences from a form or JSON body. A body that names no categories at
 * all gets the default (older clients send only an email); one that names
 * only unknown ones is an error, so a typo never silently means Business.
 */
export function parsePrefs(body: Record<string, unknown>): { prefs: Prefs } | { error: string } {
  const given = body.categories ?? body.category;
  const named = given !== undefined && given !== null && String(given).trim() !== "";
  const categories = named ? parseCategories(given) : DEFAULT_PREFS.categories;
  if (!categories.length) return { error: "Choose at least one kind of news." };
  return {
    prefs: {
      categories,
      region: parseRegion(body.region) ?? DEFAULT_PREFS.region,
      frequency: parseFrequency(body.frequency) ?? DEFAULT_PREFS.frequency,
    },
  };
}

/** Preferences as stored on a subscriber row. Tolerant: old or odd rows fall back to the defaults. */
export function prefsFromRow(row: { categories?: unknown; region?: unknown; frequency?: unknown }): Prefs {
  const categories = parseCategories(row.categories);
  return {
    categories: categories.length ? categories : DEFAULT_PREFS.categories,
    region: parseRegion(row.region) ?? DEFAULT_PREFS.region,
    frequency: parseFrequency(row.frequency) ?? DEFAULT_PREFS.frequency,
  };
}

export const serializeCategories = (categories: CategoryId[]): string => categories.join(",");

export function editionsFor(region: Region): Edition[] {
  return region === "both" ? ["nigeria", "global"] : [region];
}

export function headlineCategories(prefs: Pick<Prefs, "categories">): HeadlineCategory[] {
  return prefs.categories.filter((c): c is HeadlineCategory => c !== "business");
}

/**
 * Readers whose emails have the same content share a key, so each distinct
 * email is built once. The region only matters when a headline category is chosen.
 */
export function comboKey(prefs: Pick<Prefs, "categories" | "region">): string {
  const region = headlineCategories(prefs).length ? prefs.region : "-";
  return `${serializeCategories(prefs.categories)}|${region}`;
}

export function listLabels(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "Business and Technology (Nigeria + Global), every morning" */
export function describePrefs(prefs: Prefs): string {
  const topics = listLabels(prefs.categories.map(categoryLabel));
  const region = headlineCategories(prefs).length ? ` (${REGIONS.find((r) => r.id === prefs.region)?.label})` : "";
  const often = FREQUENCIES.find((f) => f.id === prefs.frequency)!;
  return `${topics}${region}, ${often.label.toLowerCase()}`;
}
