/**
 * One slug scheme for every entity URL on the site (/entity/first-holdco/).
 * Ported from the legacy js/entity-key.js, behaviour unchanged.
 */

/** Lower-cased, trimmed, single-spaced form used for name comparison. */
export function nameKey(value: unknown): string {
  return String(value ?? "")
    .replace(/ /g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * URL-safe slug: "First HoldCo Plc." -> "first-holdco-plc".
 * Diacritics fold to ASCII, "&" becomes "and", anything else outside
 * [a-z0-9] becomes a hyphen. Idempotent.
 */
export function slugify(value: unknown): string {
  let s = nameKey(value);
  if (!s) return "";
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return s
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function matchesSlug(name: unknown, slug: string): boolean {
  const s = slugify(name);
  return s !== "" && s === String(slug || "");
}
