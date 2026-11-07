/**
 * Names the owner has unpublished (suppressed.json, written by
 * scripts/unpublish.py). The pipeline already drops them from new exports;
 * filtering again at build time means data committed before the name was
 * added stops rendering on the very next build, without waiting for a run.
 *
 * The matching rule is the pipeline's (backend/app/services/suppression.py):
 * the hidden name appears as whole words, ignoring case. Here any text in a
 * row counts, so a row is dropped wherever it names the entity.
 */
import { mentions } from "./entities.ts";

/** The names in suppressed.json; junk entries are skipped. */
export function hiddenNames(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => (e && typeof e === "object" ? String((e as { name?: unknown }).name ?? "").trim() : ""))
    .filter(Boolean);
}

/** True when any text in `value` names a hidden entity. */
export function namesHidden(value: unknown, hidden: string[]): boolean {
  if (!hidden.length) return false;
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return hidden.some((name) => mentions(text, name));
}

export function withoutHidden<T>(rows: T[], hidden: string[]): T[] {
  return hidden.length ? rows.filter((row) => !namesHidden(row, hidden)) : rows;
}

/** Markdown (the brief) without the lines that name a hidden entity. */
export function withoutHiddenLines(markdown: string, hidden: string[]): string {
  if (!hidden.length) return markdown;
  return markdown
    .split("\n")
    .filter((line) => !namesHidden(line, hidden))
    .join("\n");
}

/** The email digest's lists without the items that name a hidden entity. */
export function scrubDigest<T extends Record<string, unknown>>(digest: T, hidden: string[]): T {
  if (!hidden.length) return digest;
  const out: Record<string, unknown> = { ...digest };
  for (const key of ["cards", "overview", "insights", "also", "psc"]) {
    if (Array.isArray(out[key])) out[key] = withoutHidden(out[key] as unknown[], hidden);
  }
  // The subject is usually the lead story's headline.
  if (namesHidden(out.subject, hidden)) out.subject = "AURA Morning Brief";
  if (namesHidden(out.preheader, hidden)) out.preheader = "";
  return out as T;
}
