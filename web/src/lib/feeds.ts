/**
 * RSS 2.0 and JSON Feed 1.1 documents for the build-time feeds
 * (/feeds/*.xml, /entity/<slug>/feed.xml, /feed.json). Pure: callers pass
 * absolute URLs, so the same code serves the root site and the GitHub copy
 * under its base path.
 */
import { isKnownCompany, type Entity } from "./entities.ts";

/**
 * The entities that get /entity/<slug>/feed.xml: known companies only. A
 * feed per person would be a tracker on an individual, and kind "company"
 * alone also covers often-mentioned people the pipeline files under
 * Company Info ("Tinubu"), so this takes isKnownCompany's test.
 */
export function entityFeeds(entities: Entity[]): Entity[] {
  return entities.filter(isKnownCompany);
}

// XML 1.0 forbids these control characters outright; one stray byte from a
// scraped headline would make the whole feed unreadable.
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

export function xmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface FeedItem {
  title: string;
  link: string;
  date: Date | null;
  description?: string;
}

export function rssFeed(channel: { title: string; link: string; self: string; description: string; items: FeedItem[] }): string {
  const items = channel.items.map((i) =>
    [
      "    <item>",
      `      <title>${xmlEscape(i.title)}</title>`,
      `      <link>${xmlEscape(i.link)}</link>`,
      `      <guid isPermaLink="false">${xmlEscape(i.link)}</guid>`,
      i.date ? `      <pubDate>${i.date.toUTCString()}</pubDate>` : "",
      i.description ? `      <description>${xmlEscape(i.description)}</description>` : "",
      "    </item>",
    ].filter(Boolean).join("\n"),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${xmlEscape(channel.title)}</title>`,
    `    <link>${xmlEscape(channel.link)}</link>`,
    `    <atom:link href="${xmlEscape(channel.self)}" rel="self" type="application/rss+xml"/>`,
    `    <description>${xmlEscape(channel.description)}</description>`,
    "    <language>en</language>",
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

export interface JsonFeedItem {
  id: string;
  url: string;
  title: string;
  date: Date;
  summary: string;
}

export function jsonFeed(feed: { title: string; homePageUrl: string; feedUrl: string; description: string; items: JsonFeedItem[] }): string {
  return JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    title: feed.title,
    home_page_url: feed.homePageUrl,
    feed_url: feed.feedUrl,
    description: feed.description,
    language: "en",
    items: feed.items.map((i) => ({ id: i.id, url: i.url, title: i.title, content_text: i.summary, date_published: i.date.toISOString() })),
  }, null, 2);
}
