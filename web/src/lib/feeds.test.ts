import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { xmlEscape, rssFeed, jsonFeed } from "./feeds.ts";

describe("feeds", () => {
  test("XML escaping covers markup, quotes and stray control characters", () => {
    assert.equal(xmlEscape(`<b>"A&B" 'c'</b>`), "&lt;b&gt;&quot;A&amp;B&quot; &apos;c&apos;&lt;/b&gt;");
    // Control characters are not allowed in XML 1.0 at all; one would break every reader.
    assert.equal(xmlEscape("bad\u0001\u000bchar\ttab"), "badchar\ttab");
    assert.equal(xmlEscape(null), "");
  });

  test("an RSS 2.0 channel with escaped items, newest first as given", () => {
    const xml = rssFeed({
      title: "AURA alerts",
      link: "https://aura.test/",
      self: "https://aura.test/feeds/alerts.xml",
      description: "High-risk stories",
      items: [
        { title: "EFCC & <CBN>", link: "https://p.test/a?x=1&y=2", date: new Date("2026-11-04T12:00:00Z"), description: "Score 70" },
        { title: "Undated", link: "https://p.test/b", date: null },
      ],
    });
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<rss version="2.0"/);
    assert.match(xml, /<atom:link href="https:\/\/aura.test\/feeds\/alerts.xml" rel="self" type="application\/rss\+xml"\/>/);
    assert.match(xml, /<title>EFCC &amp; &lt;CBN&gt;<\/title>/);
    assert.match(xml, /<link>https:\/\/p.test\/a\?x=1&amp;y=2<\/link>/);
    assert.match(xml, /<pubDate>Wed, 04 Nov 2026 12:00:00 GMT<\/pubDate>/);
    assert.match(xml, /<guid isPermaLink="false">https:\/\/p.test\/a\?x=1&amp;y=2<\/guid>/);
    assert.equal((xml.match(/<item>/g) || []).length, 2);
    assert.equal((xml.match(/<pubDate>/g) || []).length, 1);
    assert.ok(!xml.includes("<CBN>"));
  });

  test("a JSON Feed 1.1 document", () => {
    const feed = JSON.parse(jsonFeed({
      title: "AURA Morning Brief",
      homePageUrl: "https://aura.test/brief/",
      feedUrl: "https://aura.test/feed.json",
      description: "Editions",
      items: [{ id: "20261107-025300", url: "https://aura.test/brief/20261107-025300/", title: "Brief", date: new Date("2026-11-07T02:53:00Z"), summary: "12 articles" }],
    }));
    assert.equal(feed.version, "https://jsonfeed.org/version/1.1");
    assert.equal(feed.feed_url, "https://aura.test/feed.json");
    assert.equal(feed.home_page_url, "https://aura.test/brief/");
    assert.deepEqual(feed.items[0], {
      id: "20261107-025300", url: "https://aura.test/brief/20261107-025300/", title: "Brief",
      content_text: "12 articles", date_published: "2026-11-07T02:53:00.000Z",
    });
  });
});
