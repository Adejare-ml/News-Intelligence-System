/**
 * ⌘K search: a compact index built at build time, scored in the browser.
 * Ranking (ported from the legacy search.js): exact > prefix > word-start >
 * substring > subsequence, with a small boost per entry type so people and
 * companies outrank the stories that mention them.
 */

export type EntryType = "entity" | "holding" | "story" | "brief" | "page";

export interface Entry {
  t: EntryType;
  /** Label shown in the result. */
  l: string;
  /** Secondary line. */
  s: string;
  /** Destination URL (site-relative or absolute for stories). */
  u: string;
  /** Extra searchable text, lower-cased. */
  k?: string;
}

export const TYPE_LABELS: Record<EntryType, string> = {
  page: "Go to",
  entity: "People and companies",
  holding: "Holdings",
  story: "Stories",
  brief: "Brief editions",
};

// Large enough that a word-start match on a person beats a prefix match on a headline.
const TYPE_BOOST: Record<EntryType, number> = { page: 30, entity: 25, holding: 15, story: 0, brief: 0 };

function norm(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** 0 for no match, higher is better. */
export function scoreText(haystack: string, query: string): number {
  const h = norm(haystack);
  const q = norm(query).trim();
  if (!q) return 0;
  if (h === q) return 100;
  if (h.startsWith(q)) return 80;
  const at = h.indexOf(q);
  if (at > 0 && /[^a-z0-9]/.test(h[at - 1])) return 60;
  if (at >= 0) return 40;
  // Every query word appears somewhere ("otedola holdco").
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => h.includes(w))) return 30;
  // Subsequence, for typos of omission ("dngte").
  let i = 0;
  for (const ch of h) if (ch === q[i]) i++;
  return i === q.length && q.length >= 3 ? 10 : 0;
}

export function search(entries: Entry[], query: string, limit = 24): Entry[] {
  const q = query.trim();
  if (!q) return [];
  const scored: { e: Entry; score: number }[] = [];
  for (const e of entries) {
    const base = Math.max(scoreText(e.l, q), e.k ? scoreText(e.k, q) * 0.6 : 0);
    if (base > 0) scored.push({ e, score: base + TYPE_BOOST[e.t] });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.e.l.length - b.e.l.length || a.e.l.localeCompare(b.e.l))
    .slice(0, limit)
    .map((x) => x.e);
}

/** Results grouped by type in a fixed order, for rendering. */
export function group(results: Entry[]): { type: EntryType; label: string; items: Entry[] }[] {
  const order: EntryType[] = ["page", "entity", "holding", "story", "brief"];
  return order
    .map((type) => ({ type, label: TYPE_LABELS[type], items: results.filter((r) => r.t === type) }))
    .filter((g) => g.items.length > 0);
}
