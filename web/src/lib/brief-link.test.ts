import { test } from "node:test";
import assert from "node:assert/strict";
import { briefLink, briefSource } from "./brief-link.ts";

test("the source tag names the edition, in the form /api/hit accepts", () => {
  assert.equal(briefSource("20261107-11218"), "brief-20261107-11218");
  assert.equal(briefSource("20261107-11218-preview"), "brief-20261107-11218-preview");
  assert.equal(briefSource("Odd_Edition id"), "brief-odd-edition-id");
  assert.equal(briefSource("x".repeat(60)).length, 40);
  assert.match(briefSource("x".repeat(60)), /^[a-z0-9-]{1,40}$/);
  assert.equal(briefSource(""), "");
});

test("site links carry the tag; with no edition they stay plain", () => {
  assert.equal(briefLink("https://auranews.pages.dev", "brief/", "brief-1"), "https://auranews.pages.dev/brief/?src=brief-1");
  assert.equal(briefLink("https://auranews.pages.dev", "news/sports/", ""), "https://auranews.pages.dev/news/sports/");
});
