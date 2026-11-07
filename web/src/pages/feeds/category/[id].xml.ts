/**
 * /feeds/category/<id>.xml: one RSS feed per headline category, Nigeria and
 * Global editions together, newest first. Business has no file here: its
 * feed is the Morning Brief (/data/feed.xml and /feed.json).
 */
import * as data from "../../../lib/data.ts";
import { href } from "../../../lib/url.ts";
import { rssFeed } from "../../../lib/feeds.ts";
import { publishedDate, regionLists } from "../../../lib/category-news.ts";
import { cleanTitle } from "../../../lib/stories.ts";
import { CATEGORIES, HEADLINE_CATEGORIES } from "../../../../functions/_lib/categories.ts";

export function getStaticPaths() {
  return HEADLINE_CATEGORIES.map((id) => ({ params: { id } }));
}

export function GET({ params, site }: { params: { id: string }; site?: URL }) {
  const abs = (path: string) => new URL(href(path), site).toString();
  const label = CATEGORIES.find((c) => c.id === params.id)?.label ?? params.id;
  const items = regionLists(data.categoryNews(), params.id)
    .flatMap((l) => l.items.map((h) => ({
      title: cleanTitle(h.title, h.source).title,
      link: h.url,
      date: publishedDate(h.published),
      description: `${l.label} · ${h.source}`,
    })))
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
  const xml = rssFeed({
    title: `AURA · ${label}`,
    link: abs(`news/${params.id}/`),
    self: abs(`feeds/category/${params.id}.xml`),
    description: `${label} headlines from Nigeria and around the world, collected by AURA four times a day.`,
    items,
  });
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
