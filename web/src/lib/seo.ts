/**
 * Search-engine metadata: page titles and descriptions, schema.org JSON-LD
 * and the sitemap. Pure functions so the wording and escaping are tested.
 */
import { clip } from "./stories.ts";

/**
 * JSON for a <script type="application/ld+json"> block. "<" is written as
 * < so a name containing "</script>" cannot end the block early; JSON
 * parsers read the escape back as the same character.
 */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * A company or public body as schema.org Organization. Its `url` would claim
 * the organisation's own website, which AURA does not know, so the AURA page
 * is given as the page about it instead.
 */
export function organizationLd(o: { name: string; url: string; logo?: string }) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: o.name,
    mainEntityOfPage: o.url,
    ...(o.logo ? { logo: o.logo } : {}),
  };
}

/** The site itself, with the register's ?q= search as its search action. */
export function websiteLd(siteUrl: string, searchTemplate: string) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "AURA",
    url: siteUrl,
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: searchTemplate },
      "query-input": "required name=search_term_string",
    },
  };
}

// Search results cut descriptions at about 160 characters.
const DESCRIPTION_MAX = 160;

// "other" is a name we cannot confirm is a company (often a person the
// pipeline filed as one), so its wording makes no ownership claim.
const ENTITY_META = {
  company: {
    title: ": who owns and controls it",
    tail: ": who the news reports as owning or controlling it, board moves and contracts. Based on press reports, not CAC filings.",
  },
  person: {
    title: ": reported company holdings",
    tail: ": companies the news reports them as owning or controlling. Based on press reports, not CAC filings.",
  },
  other: {
    title: " in the news",
    tail: ": recent Nigerian business and regulatory reports that mention it, tracked by AURA.",
  },
};

/** Title and description for an entity page: its name first, then what AURA tracks about it. */
export function entityMeta(name: string, kind: keyof typeof ENTITY_META) {
  const { title, tail } = ENTITY_META[kind];
  return {
    title: `${name}${title} · AURA`,
    description: `${clip(name, DESCRIPTION_MAX - tail.length)}${tail}`,
  };
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Sitemap XML. `lastmod` is left out when unknown rather than guessed. */
export function sitemapXml(entries: { loc: string; lastmod: Date | null }[]): string {
  const urls = entries.map(({ loc, lastmod }) => {
    const mod = lastmod ? `<lastmod>${lastmod.toISOString().replace(/\.\d{3}Z$/, "Z")}</lastmod>` : "";
    return `  <url><loc>${xmlEscape(loc)}</loc>${mod}</url>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
