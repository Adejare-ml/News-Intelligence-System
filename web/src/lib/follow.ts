/**
 * Follow by email, build side: which companies can be followed and what
 * counts as new reporting on one for the next Morning Brief. The pages under
 * /brief/email/follow/ use these; /api/send-brief reads those pages.
 */
import { articleMentions, type Entity } from "./entities.ts";
import { parseTime, toStory, type Article, type Story } from "./stories.ts";

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
