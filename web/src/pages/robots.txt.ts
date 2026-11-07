import { href } from "../lib/url.ts";

export function GET({ site }: { site?: URL }) {
  const sitemap = new URL(href("sitemap.xml"), site ?? "https://auranews.pages.dev").toString();
  // The email copy of the Morning Brief duplicates the brief pages and is
  // only fetched by /api/send-brief, so crawlers are kept off it.
  return new Response(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /img\nDisallow: ${href("brief/email/")}\n\nSitemap: ${sitemap}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
