import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { jsonLd, organizationLd, websiteLd, entityMeta, sitemapXml } from "./seo.ts";
import { HEADLINE_CATEGORIES } from "../../functions/_lib/categories.ts";

describe("seo", () => {
  test("JSON-LD cannot close its own script tag", () => {
    const out = jsonLd({ name: "</script><script>alert(1)</script>" });
    assert.ok(!out.includes("<"), out);
    assert.equal(JSON.parse(out).name, "</script><script>alert(1)</script>");
  });

  test("a company page describes the company as an Organization on its AURA page", () => {
    const ld = organizationLd({ name: "Dangote Cement Plc", url: "https://auranews.pages.dev/entity/dangote-cement-plc/" });
    assert.equal(ld["@context"], "https://schema.org");
    assert.equal(ld["@type"], "Organization");
    assert.equal(ld.name, "Dangote Cement Plc");
    assert.equal(ld.mainEntityOfPage, "https://auranews.pages.dev/entity/dangote-cement-plc/");
    assert.equal("logo" in ld, false);
    assert.equal(organizationLd({ name: "X", url: "u", logo: "https://a/l.png" }).logo, "https://a/l.png");
  });

  test("the home page declares the site and its search", () => {
    const ld = websiteLd("https://auranews.pages.dev/", "https://auranews.pages.dev/register/?q={search_term_string}");
    assert.equal(ld["@type"], "WebSite");
    assert.equal(ld.url, "https://auranews.pages.dev/");
    assert.deepEqual(ld.potentialAction, {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: "https://auranews.pages.dev/register/?q={search_term_string}" },
      "query-input": "required name=search_term_string",
    });
  });

  test("entity titles name the entity and what AURA tracks; descriptions fit a result snippet", () => {
    const company = entityMeta("Dangote Cement Plc", "company");
    assert.equal(company.title, "Dangote Cement Plc: who owns and controls it · AURA");
    assert.match(company.description, /^Dangote Cement Plc: /);
    assert.match(company.description, /press reports, not CAC filings/);
    assert.ok(company.description.length <= 160, String(company.description.length));

    const person = entityMeta("Aliko Dangote", "person");
    assert.equal(person.title, "Aliko Dangote: reported company holdings · AURA");
    assert.ok(person.description.length <= 160);

    const long = entityMeta("A".repeat(150), "company");
    assert.ok(long.description.length <= 160);
  });

  test("a name not known to be a company or holder gets a neutral title, no ownership claim", () => {
    const other = entityMeta("Tinubu", "other");
    assert.equal(other.title, "Tinubu in the news · AURA");
    assert.doesNotMatch(other.description, /own|control/i);
    assert.match(other.description, /^Tinubu: /);
    assert.ok(other.description.length <= 160);
  });

  test("sitemap entries carry lastmod only when a date is known, and escape URLs", () => {
    const xml = sitemapXml([
      { loc: "https://a.dev/news/", lastmod: new Date("2026-11-06T06:30:00Z") },
      { loc: "https://a.dev/?a=1&b=2", lastmod: null },
    ]);
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<url><loc>https:\/\/a.dev\/news\/<\/loc><lastmod>2026-11-06T06:30:00Z<\/lastmod><\/url>/);
    assert.match(xml, /<url><loc>https:\/\/a.dev\/\?a=1&amp;b=2<\/loc><\/url>/);
  });

  test("the retired Sports and Entertainment pages, still linked from sent briefs and old sitemaps, redirect to News", () => {
    const rules = readFileSync(resolve(import.meta.dirname, "../../public/_redirects"), "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split(/\s+/));
    for (const retired of ["sports", "entertainment"]) {
      for (const path of [`/news/${retired}`, `/news/${retired}/`]) {
        assert.deepEqual(rules.find(([from]) => from === path)?.slice(1), ["/news/", "301"], path);
      }
    }
    // Cloudflare follows a redirect even when the page exists, so none may cover a section still built.
    for (const live of HEADLINE_CATEGORIES) {
      assert.ok(!rules.some(([from]) => from.startsWith(`/news/${live}`)), live);
    }
  });

  test("the noindexed entity pages' Markdown copies and the register CSV are noindex too; /downloads/ is not", () => {
    // public/_headers: a path line (Cloudflare's * matches anything), then indented "Name: value" lines.
    const rules: { path: RegExp; headers: string[] }[] = [];
    for (const line of readFileSync(resolve(import.meta.dirname, "../../public/_headers"), "utf-8").split("\n")) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      if (/^\s/.test(line)) rules.at(-1)?.headers.push(line.trim().toLowerCase());
      else rules.push({ path: new RegExp(`^${line.trim().split("*").map((s) => s.replace(/[.?+^$()[\]{}|\\]/g, "\\$&")).join(".*")}$`), headers: [] });
    }
    const noindex = (url: string) => rules.some((r) => r.path.test(url) && r.headers.includes("x-robots-tag: noindex"));
    for (const url of ["/entity/quickmart.md", "/entity/international-finance-corporation-at-quickmart.md", "/entity/quickmart/feed.xml", "/downloads/register.csv"]) {
      assert.ok(noindex(url), url);
    }
    for (const url of ["/", "/downloads/", "/register/", "/news/"]) assert.ok(!noindex(url), url);
  });
});
