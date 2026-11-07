/**
 * Follow by email: the companies a reader follows (table follows, migration
 * 0007), the throttle on the site's follow form (follow_requests), and the
 * build-time list of companies that can be followed.
 */
import type { D1Like, Env } from "./http.ts";

/** Keeps each Following block short enough to read and cheap to build. */
export const MAX_FOLLOWS = 20;
/** One follow email per address in this window, so the form cannot flood an inbox. */
export const REQUEST_GAP_MINUTES = 10;
/** The throttle only needs recent rows; older ones are deleted so addresses are not kept. */
const REQUEST_KEEP_HOURS = 24;

/** Built by web/src/pages/brief/email/follow/index.json.ts: companies with a page, published data only. */
export const FOLLOWABLE_PATH = "/brief/email/follow/index.json";

export function followStore(db: D1Like) {
  return {
    async list(token: string): Promise<string[]> {
      const { results } = await db.prepare("SELECT slug FROM follows WHERE token = ? ORDER BY slug").bind(token).all<{ slug: string }>();
      return (results ?? []).map((r) => r.slug);
    },

    /** "full" when the reader already follows MAX_FOLLOWS companies. */
    async add(token: string, slug: string, now: string): Promise<"added" | "already" | "full"> {
      const have = await this.list(token);
      if (have.includes(slug)) return "already";
      if (have.length >= MAX_FOLLOWS) return "full";
      await db.prepare("INSERT OR IGNORE INTO follows (token, slug, created_at) VALUES (?, ?, ?)").bind(token, slug, now).run();
      return "added";
    },

    async remove(token: string, slug: string): Promise<void> {
      await db.prepare("DELETE FROM follows WHERE token = ? AND slug = ?").bind(token, slug).run();
    },

    /** Follows of everyone who gets a brief at all, in one query: token -> sorted slugs. */
    async forRecipients(): Promise<Map<string, string[]>> {
      const { results } = await db
        .prepare(
          "SELECT f.token, f.slug FROM follows f JOIN subscribers s ON s.token = f.token WHERE s.status = 'confirmed' AND s.paused = 0 ORDER BY f.token, f.slug",
        )
        .bind()
        .all<{ token: string; slug: string }>();
      const out = new Map<string, string[]>();
      for (const r of results ?? []) out.set(r.token, [...(out.get(r.token) ?? []), r.slug]);
      return out;
    },
  };
}

export function followRequests(db: D1Like) {
  return {
    /**
     * True (and the time recorded) when this address has had no follow email
     * in the last REQUEST_GAP_MINUTES. Refused tries leave the clock alone.
     */
    async allow(email: string, now: Date): Promise<boolean> {
      const keepFrom = new Date(now.getTime() - REQUEST_KEEP_HOURS * 3_600_000).toISOString();
      await db.prepare("DELETE FROM follow_requests WHERE requested_at < ?").bind(keepFrom).run();
      const since = new Date(now.getTime() - REQUEST_GAP_MINUTES * 60_000).toISOString();
      const recent = await db.prepare("SELECT 1 AS hit FROM follow_requests WHERE email = ? AND requested_at > ?").bind(email, since).first();
      if (recent) return false;
      await db
        .prepare("INSERT INTO follow_requests (email, requested_at) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET requested_at = excluded.requested_at")
        .bind(email, now.toISOString())
        .run();
      return true;
    },
  };
}

/** slug -> company name, from the built site. Empty when the list is missing or unreadable. */
export async function loadFollowable(env: Env, origin: string): Promise<Map<string, string>> {
  if (!env.ASSETS) return new Map();
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(FOLLOWABLE_PATH, origin)));
    if (!res.ok) return new Map();
    const body = (await res.json()) as { companies?: { slug?: unknown; name?: unknown }[] };
    return new Map((body.companies ?? []).filter((c) => typeof c.slug === "string" && typeof c.name === "string").map((c) => [c.slug as string, c.name as string]));
  } catch {
    return new Map();
  }
}

/** The slug of a company typed by name (any case and spacing) or by slug; null when it is not followable. */
export function matchCompany(input: unknown, followable: Map<string, string>): string | null {
  const typed = String(input ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!typed) return null;
  if (followable.has(typed)) return typed;
  for (const [slug, name] of followable) if (name.toLowerCase() === typed) return slug;
  return null;
}
