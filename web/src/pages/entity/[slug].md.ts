/** /entity/<slug>.md: the entity page's facts as Markdown, for notes and newsrooms. */
import { href } from "../../lib/url.ts";
import { siteEntities } from "../../lib/site-entities.ts";
import { entityMarkdown } from "../../lib/entity-export.ts";
import type { Entity } from "../../lib/entities.ts";

export function getStaticPaths() {
  return siteEntities().map((entity) => ({ params: { slug: entity.slug }, props: { entity } }));
}

export function GET({ props, site }: { props: { entity: Entity }; site?: URL }) {
  const abs = (path: string) => new URL(href(path), site).toString();
  const md = entityMarkdown(props.entity, {
    pageUrl: abs(`entity/${props.entity.slug}/`),
    entityUrl: (slug) => abs(`entity/${slug}/`),
  });
  return new Response(md, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
