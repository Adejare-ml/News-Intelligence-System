/**
 * /feed.json: the Morning Brief editions as JSON Feed 1.1, each linking to
 * its page on this site. Items carry the run's counts only, never the
 * brief's text, so nothing here can say more than the edition pages do.
 */
import * as data from "../lib/data.ts";
import { href } from "../lib/url.ts";
import { jsonFeed } from "../lib/feeds.ts";
import { listEditions } from "../lib/archive.ts";
import { lagosDate, lagosTime } from "../lib/edition.ts";

const FEED_EDITIONS = 30;

export function GET({ site }: { site?: URL }) {
  const abs = (path: string) => new URL(href(path), site).toString();
  const byFile = new Map(data.reports().map((r) => [String(r["Archive File"] ?? ""), r]));
  const items = listEditions().slice(0, FEED_EDITIONS).map((e) => {
    const run = byFile.get(e.file);
    const counts = run ? ` ${run["Total Articles"] ?? 0} articles read, ${run["High Risk"] ?? 0} high-risk.` : "";
    return {
      id: e.slug,
      url: abs(`brief/${e.slug}/`),
      title: `Brief of ${lagosDate(e.date)}, ${lagosTime(e.date)}`,
      date: e.date,
      summary: `AURA's brief as published on ${lagosDate(e.date)} at ${lagosTime(e.date)} Lagos time.${counts}`,
    };
  });
  const body = jsonFeed({
    title: "AURA Morning Brief",
    homePageUrl: abs("brief/"),
    feedUrl: abs("feed.json"),
    description: "Who controls Nigeria's companies: ownership changes, board moves and public contracts, four times a day.",
    items,
  });
  return new Response(body, { headers: { "Content-Type": "application/feed+json; charset=utf-8" } });
}
