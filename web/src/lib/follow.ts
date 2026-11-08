/**
 * Following companies, two ways:
 *  - "Follow" on company pages, kept in this browser only (localStorage). Pure
 *    helpers for the client script (scripts/follow.ts), so the matching is
 *    tested here and the script only does storage and the DOM.
 *  - Follow by email, build side: which companies can be followed and what
 *    counts as new reporting on one for the next Morning Brief. The pages
 *    under /brief/email/follow/ use these; /api/send-brief reads those pages.
 */
import { articleMentions, mentions, type Entity } from "./entities.ts";
import { nameKey, slugify } from "./entity-key.ts";
import { cleanAlerts, type RawAlert } from "./alerts.ts";
import { cleanTitle, parseTime, toStory, type Article, type Story } from "./stories.ts";

/* ---------- Follow in this browser ---------- */

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

/** /following.json: what the panel and the bell dot fetch. */
export interface FollowingFeed {
  articles: Article[];
  alerts: FollowAlert[];
}

/**
 * The stories and alerts for /following.json, cut to the fields the panel
 * and the dot match on. The page builds it from data.articles() and
 * data.alerts(), the rows the inbox embeds, so the dot's ids are the
 * inbox's and an unpublished name is gone on the next build.
 */
export function followingFeed(articles: Article[], alerts: FollowAlert[]): FollowingFeed {
  return {
    articles: articles.map(({ Title, Summary, Entities, URL, Source, Time }) => ({ Title, Summary, Entities, URL, Source, Time })),
    alerts: alerts.map(({ date, title, url, source, entities, risk_score, risk_level }) => ({ date, title, url, source, entities, risk_score, risk_level })),
  };
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

/* ---------- Follow by email (build side) ---------- */

/** data/digests/last_edition.json, written after each send (scripts/record_sent_edition.py). */
export interface EditionMarker {
  through_id?: unknown;
}

const DAY_MS = 24 * 3_600_000;

/**
 * Articles the next brief has not carried yet: newer than the last emailed
 * edition when the marker says where it ended, else the last 24 hours.
 */
export function editionWindow(articles: Article[], marker: EditionMarker | null, now: Date): Article[] {
  const through = Number(marker?.through_id);
  if (marker?.through_id !== undefined && Number.isFinite(through)) {
    return articles.filter((a) => Number(a.ID) > through);
  }
  return articles.filter((a) => {
    const t = parseTime(a.Time);
    return t !== null && now.getTime() - t.getTime() <= DAY_MS;
  });
}

/** One company's stories in `articles`, newest first, one per link. */
export function companyNews(name: string, articles: Article[], max: number): Story[] {
  const seen = new Set<string>();
  return articles
    .filter((a) => articleMentions(a, name))
    .map(toStory)
    .sort((x, y) => (y.published?.getTime() ?? 0) - (x.published?.getTime() ?? 0))
    .filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)))
    .slice(0, max);
}

/** Companies only: a reader follows businesses, never a person. */
export function followableCompanies(entities: Entity[]): { slug: string; name: string }[] {
  return entities.filter((e) => e.kind === "company").map((e) => ({ slug: e.slug, name: e.name }));
}
