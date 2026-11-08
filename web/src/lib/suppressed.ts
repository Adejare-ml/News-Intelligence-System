/**
 * Names the owner has unpublished (suppressed.json, written by
 * scripts/unpublish.py). The pipeline already drops them from new exports;
 * filtering again at build time means data committed before the name was
 * added stops rendering on the very next build, without waiting for a run.
 *
 * The matching rule is the pipeline's (backend/app/services/suppression.py),
 * applied to each text value in a row on its own: the hidden name appears
 * as whole words (ignoring case, accents, punctuation, initials and
 * honorifics), or the whole value has the same canonical key the register
 * groups by ("Dangote Cement" and "Dangote Cement Plc" are one company).
 */

// Ported from backend/app/services/register_quality.py; tests/test_suppression.py
// checks these lists still match it.
const HONORIFICS = new Set([
  "alhaji", "alhaja", "hajia", "hajiya", "chief", "dr", "sir", "mr", "mrs",
  "ms", "otunba", "engr", "prof", "professor", "senator", "sen", "hon",
  "barr", "pastor", "oba", "dame", "lady", "arc", "high", "amb",
]);
const COMPANY_SUFFIXES = new Set([
  "plc", "ltd", "limited", "nigeria", "nig", "co", "company", "inc",
  "llc", "group", "holdings",
]);
const COMPANY_ALIASES: Record<string, string> = {
  "dangote petroleum refinery": "dangote refinery",
  "dangote petroleum refinery and petrochemicals": "dangote refinery",
  "dangote oil refinery": "dangote refinery",
  "firstholdco": "first holdco",
  "fbn holdings": "first holdco",
  "united bank for africa uba": "united bank for africa",
  "uba": "united bank for africa",
  "seplat energy": "seplat",
  "seplat petroleum development": "seplat",
};

// Shorter names would match inside unrelated words and initials.
const MIN_LEN = 3;

/** Lower-case, strip accents and punctuation, collapse spaces. */
function fold(text: unknown): string {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const noInitials = (text: string) => text.split(" ").filter((w) => w.length > 1).join(" ");

/** register_quality.canonical_person: "Alhaji Tony O. Elumelu" -> "tony elumelu". */
export function canonicalPerson(name: unknown): string {
  let words = fold(name).split(" ").filter(Boolean);
  while (words.length && HONORIFICS.has(words[0])) words = words.slice(1);
  if (words.length > 2) words = words.filter((w, i) => !(w.length === 1 && i > 0 && i < words.length - 1));
  return words.join(" ");
}

/** register_quality.canonical_company: "Seplat Energy Plc" -> "seplat". */
export function canonicalCompany(name: unknown): string {
  const folded = fold(name);
  if (COMPANY_ALIASES[folded]) return COMPANY_ALIASES[folded];
  const words = folded.split(" ").filter(Boolean);
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop();
  const key = words.join(" ");
  return COMPANY_ALIASES[key] ?? key;
}

type Matcher = (text: string) => boolean;

/** The hidden names, prepared once for matching many values. */
function matcher(hidden: string[]): Matcher {
  const needles = new Set<string>();
  const keys = new Set<string>();
  for (const name of hidden) {
    needles.add(noInitials(fold(name)));
    needles.add(noInitials(canonicalPerson(name)));
    const company = canonicalCompany(name);
    // A company key that shrinks to one word ("access") is for whole values only.
    if (company.split(" ").length > 1) needles.add(company);
    keys.add(canonicalPerson(name));
    keys.add(company);
  }
  const words = [...needles].filter((n) => n.length >= MIN_LEN);
  for (const k of keys) if (k.length < MIN_LEN) keys.delete(k);
  if (!words.length) return () => false;
  // Folded text holds only [a-z0-9 ], so the needles need no escaping.
  const pattern = new RegExp(`(^| )(${words.join("|")})( |$)`);
  return (text) => {
    if (!text.trim()) return false;
    if (pattern.test(noInitials(fold(text)))) return true;
    // Entities columns hold several names: "Ada Obi|Kola Holdings".
    return text.split("|").some((part) => keys.has(canonicalPerson(part)) || keys.has(canonicalCompany(part)));
  };
}

/** Every text value in a row, nested arrays and objects included. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value && typeof value === "object") for (const v of Object.values(value)) yield* strings(v);
}

function rowNames(match: Matcher, value: unknown): boolean {
  for (const text of strings(value)) if (match(text)) return true;
  return false;
}

/** The names in suppressed.json; junk entries are skipped. */
export function hiddenNames(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => (e && typeof e === "object" ? String((e as { name?: unknown }).name ?? "").trim() : ""))
    .filter(Boolean);
}

/** True when any text in `value` names a hidden entity. */
export function namesHidden(value: unknown, hidden: string[]): boolean {
  return hidden.length > 0 && rowNames(matcher(hidden), value);
}

export function withoutHidden<T>(rows: T[], hidden: string[]): T[] {
  if (!hidden.length) return rows;
  const match = matcher(hidden);
  return rows.filter((row) => !rowNames(match, row));
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
  for (const key of ["cards", "overview", "insights", "also", "psc", "psc_keys"]) {
    if (Array.isArray(out[key])) out[key] = withoutHidden(out[key] as unknown[], hidden);
  }
  // The subject is usually the lead story's headline.
  if (namesHidden(out.subject, hidden)) out.subject = "AURA Morning Brief";
  if (namesHidden(out.preheader, hidden)) out.preheader = "";
  return out as T;
}
