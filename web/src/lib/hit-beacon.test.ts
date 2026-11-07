import { test } from "node:test";
import assert from "node:assert/strict";
import { pageHit, trackingAllowed } from "./hit-beacon.ts";

test("counts only on the Cloudflare site, and never against a reader's privacy signals", () => {
  assert.equal(trackingAllowed({}, "/"), true);
  assert.equal(trackingAllowed({ doNotTrack: "0", globalPrivacyControl: false }, "/"), true);
  assert.equal(trackingAllowed({ doNotTrack: "1" }, "/"), false);
  assert.equal(trackingAllowed({ globalPrivacyControl: true }, "/"), false);
  // The GitHub Pages copy lives under a base path and has no Functions.
  assert.equal(trackingAllowed({}, "/News-Intelligence-System/"), false);
});

test("a plain visit sends the path and leaves the address alone", () => {
  assert.deepEqual(pageHit({ pathname: "/brief/", search: "?q=x", hash: "#top" }), { body: { p: "/brief/" }, cleanUrl: null });
});

test("a Morning Brief click sends its source, then drops ?src= from the address", () => {
  assert.deepEqual(pageHit({ pathname: "/brief/", search: "?src=brief-20261107-11218", hash: "" }), {
    body: { p: "/brief/", s: "brief-20261107-11218" },
    cleanUrl: "/brief/",
  });
  assert.deepEqual(pageHit({ pathname: "/news/", search: "?topic=sports&src=brief-1", hash: "#a" }), {
    body: { p: "/news/", s: "brief-1" },
    cleanUrl: "/news/?topic=sports#a",
  });
});
