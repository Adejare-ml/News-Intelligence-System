/** /entity/<slug>/feed.xml: stories mentioning a company, the same ones its page lists. */
import { href } from "../../../lib/url.ts";
import { rssFeed } from "../../../lib/feeds.ts";
import { toStory } from "../../../lib/stories.ts";
import { siteEntities } from "../../../lib/site-entities.ts";
import type { Entity } from "../../../lib/entities.ts";

// Companies only: a feed per person would be a tracker on an individual.
export function getStaticPaths() {
  return siteEntities()
    .filter((e) => e.kind === "company")
    .map((entity) => ({ params: { slug: entity.slug }, props: { entity } }));
}

export function GET({ props, site }: { props: { entity: Entity }; site?: URL }) {
  const e = props.entity;
  const abs = (path: string) => new URL(href(path), site).toString();
  const xml = rssFeed({
    title: `AURA · ${e.name}`,
    link: abs(`entity/${e.slug}/`),
    self: abs(`entity/${e.slug}/feed.xml`),
    description: `News that mentions ${e.name}, from AURA's reading of Nigerian business news.`,
    items: e.articles.map(toStory).map((s) => ({ title: s.title, link: s.url, date: s.published, description: s.publisher })),
  });
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
