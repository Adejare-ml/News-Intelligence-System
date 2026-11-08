/**
 * "Follow" on company pages, kept in this browser only (localStorage). Pure
 * helpers for the client script (scripts/follow.ts), so the matching is
 * tested here and the script only does storage and the DOM.
 */
import { articleMentions, mentions } from "./entities.ts";
import { nameKey, slugify } from "./entity-key.ts";
import { cleanAlerts, type RawAlert } from "./alerts.ts";
import { cleanTitle, parseTime, type Article } from "./stories.ts";

export interface Follow {
  slug: string;
  name: string;
}

/** alerts.json rows carry the entities the article names. */
export interface FollowAlert extends RawAlert {
  entities?: string[];
}

export const FOLLOW_KEY = "aura-following";

/**
 * A follow saved from a person's page: its slug is holderSlug(name, company).
 * That page is one holder at one company, but a follow matches news by name
 * alone, so it would show another person of the same name. A company's slug
 * is slugify(name), so a company with "at" in its name is never caught.
 */
const isHolderFollow = (f: Follow) => f.slug.startsWith(`${slugify(f.name)}-at-`);

/**
 * Whatever is in storage (edited by hand, an older format): keep only
 * well-formed company entries. Follow is offered on company pages only.
 */
export function parseFollows(raw: string | null): Follow[] {
  try {
    const list = JSON.parse(raw ?? "[]");
    if (!Array.isArray(list)) return [];
    return list.filter((f) => f && typeof f.slug === "string" && f.slug && typeof f.name === "string" && f.name && !isHolderFollow(f));
  } catch {
    return [];
  }
}

export function toggleFollow(list: Follow[], item: Follow): Follow[] {
  return list.some((f) => f.slug === item.slug) ? list.filter((f) => f.slug !== item.slug) : [...list, item];
}

function alertMentions(a: FollowAlert, name: string): boolean {
  if ((a.entities ?? []).map(nameKey).includes(nameKey(name))) return true;
  return mentions(String(a.title ?? ""), name);
}

export interface Mention {
  title: string;
  url: string;
  source: string;
  date: string;
}

/** The newest story (latest.json) or alert (alerts.json) that names the entity. */
export function latestMention(name: string, articles: Article[], alerts: FollowAlert[]): Mention | null {
  // Article times come as ISO or as feed dates ("Fri, 06 Nov 2026 ..."), so compare parsed times.
  const found = [
    ...articles.filter((a) => articleMentions(a, name)).map((a) => ({ at: parseTime(a.Time), title: a.Title, url: a.URL, source: a.Source })),
    // Alerts carry a day only; noon keeps a same-day story with a time comparable.
    ...alerts.filter((a) => alertMentions(a, name)).map((a) => ({ at: parseTime(`${String(a.date ?? "").slice(0, 10)}T12:00:00Z`), title: a.title, url: a.url, source: a.source })),
  ].sort((x, y) => (y.at?.getTime() ?? 0) - (x.at?.getTime() ?? 0))[0];
  if (!found) return null;
  const { title, publisher } = cleanTitle(String(found.title ?? ""), String(found.source ?? ""));
  return { title, url: String(found.url ?? ""), source: publisher || String(found.source ?? ""), date: found.at?.toISOString().slice(0, 10) ?? "" };
}

/**
 * True when an alert the inbox shows is unread and names a followed entity.
 * Ids come from cleanAlerts, the same function the inbox uses, so "read"
 * means exactly what the inbox means by it.
 */
export function hasNewFollowedAlert(alerts: FollowAlert[], follows: Follow[], read: Set<string>): boolean {
  if (!follows.length) return false;
  const shown = new Set(cleanAlerts(alerts).map((a) => a.id));
  return alerts.some((a) => {
    const id = cleanAlerts([a])[0]?.id;
    return id !== undefined && shown.has(id) && !read.has(id) && follows.some((f) => alertMentions(a, f.name));
  });
}
