import { href } from "../lib/url.ts";

export function GET({ site }: { site?: URL }) {
  const sitemap = new URL(href("sitemap.xml"), site ?? "https://auranews.pages.dev").toString();
  return new Response(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /img\n\nSitemap: ${sitemap}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
