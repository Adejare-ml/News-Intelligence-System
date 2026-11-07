/**
 * Where a named person or company can ask for a correction or removal.
 * Set PUBLIC_CORRECTIONS_URL at build time to use an email form or a
 * mailto: address; by default it opens a pre-filled issue on the public
 * repository.
 */
const DEFAULT = "https://github.com/Adejare-ml/News-Intelligence-System/issues/new";

export function correctionUrl(subject = ""): string {
  const base = import.meta.env.PUBLIC_CORRECTIONS_URL || DEFAULT;
  if (base.startsWith("mailto:")) {
    return `${base}${base.includes("?") ? "&" : "?"}subject=${encodeURIComponent(`Correction: ${subject}`.trim())}`;
  }
  if (base !== DEFAULT) return base;
  const title = encodeURIComponent(`Correction: ${subject}`.trim());
  const body = encodeURIComponent(
    "What is wrong, and what is correct (with a source if you have one):\n\n" +
      "Are you the person or company named? (yes / no)\n",
  );
  return `${DEFAULT}?labels=correction&title=${title}&body=${body}`;
}

/** One entry in the public corrections log (corrections.json, kept by the owner). */
export interface Correction {
  date: string;
  ref: string;
  what_changed: string;
  reason: string;
}

/** The log, newest first. Entries without a date or a change are skipped. */
export function readCorrections(raw: unknown): Correction[] {
  if (!Array.isArray(raw)) return [];
  const text = (v: unknown) => String(v ?? "").trim();
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({ date: text(e.date), ref: text(e.ref), what_changed: text(e.what_changed), reason: text(e.reason) }))
    .filter((e) => e.date && e.what_changed)
    .sort((a, b) => b.date.localeCompare(a.date));
}
