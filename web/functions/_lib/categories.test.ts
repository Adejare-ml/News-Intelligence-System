import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comboKey, describePrefs, editionsFor, headlineCategories, parseCategories, parsePrefs, prefsFromRow, HEADLINE_CATEGORIES,
} from "./categories.ts";

test("parseCategories keeps known ids once, in display order", () => {
  assert.deepEqual(parseCategories(["sports", "business", "SPORTS", "chess"]), ["business", "sports"]);
  assert.deepEqual(parseCategories("politics, technology"), ["technology", "politics"]);
  assert.deepEqual(parseCategories("sports"), ["sports"]);
  assert.deepEqual(parseCategories(undefined), []);
});

test("parsePrefs defaults an old client that sends only an email", () => {
  assert.deepEqual(parsePrefs({ email: "a@b.co" }), { prefs: { categories: ["business"], region: "nigeria", frequency: "daily" } });
});

test("parsePrefs rejects a list with nothing it knows", () => {
  assert.deepEqual(parsePrefs({ categories: ["chess"] }), { error: "Choose at least one kind of news." });
  assert.deepEqual(parsePrefs({ categories: [] }), { prefs: { categories: ["business"], region: "nigeria", frequency: "daily" } });
});

test("parsePrefs reads region and frequency, ignoring junk", () => {
  const out = parsePrefs({ categories: "sports", region: "both", frequency: "weekly" });
  assert.deepEqual(out, { prefs: { categories: ["sports"], region: "both", frequency: "weekly" } });
  const junk = parsePrefs({ categories: "sports", region: "mars", frequency: "hourly" });
  assert.deepEqual(junk, { prefs: { categories: ["sports"], region: "nigeria", frequency: "daily" } });
});

test("prefsFromRow falls back for legacy rows", () => {
  assert.deepEqual(prefsFromRow({}), { categories: ["business"], region: "nigeria", frequency: "daily" });
  assert.deepEqual(prefsFromRow({ categories: "", region: "global" }).categories, ["business"]);
});

test("comboKey ignores region when only Business is chosen", () => {
  assert.equal(comboKey({ categories: ["business"], region: "global" }), comboKey({ categories: ["business"], region: "nigeria" }));
  assert.notEqual(comboKey({ categories: ["sports"], region: "global" }), comboKey({ categories: ["sports"], region: "nigeria" }));
});

test("editions and headline categories", () => {
  assert.deepEqual(editionsFor("both"), ["nigeria", "global"]);
  assert.deepEqual(editionsFor("global"), ["global"]);
  assert.deepEqual(headlineCategories({ categories: ["business", "sports"] }), ["sports"]);
  assert.deepEqual(HEADLINE_CATEGORIES, ["sports", "technology", "politics", "entertainment"]);
});

test("describePrefs reads naturally", () => {
  assert.equal(describePrefs({ categories: ["business"], region: "global", frequency: "daily" }), "Business, every morning");
  assert.equal(
    describePrefs({ categories: ["business", "sports", "politics"], region: "both", frequency: "weekly" }),
    "Business, Sports and Politics (Nigeria + Global), once a week",
  );
});
