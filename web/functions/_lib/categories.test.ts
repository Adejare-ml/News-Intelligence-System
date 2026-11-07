import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comboKey, describePrefs, editionsFor, headlineCategories, parseCategories, parsePrefs, prefsFromRow, CATEGORIES, HEADLINE_CATEGORIES,
} from "./categories.ts";

test("parseCategories keeps known ids once, in display order", () => {
  assert.deepEqual(parseCategories(["politics", "business", "POLITICS", "chess"]), ["business", "politics"]);
  assert.deepEqual(parseCategories("politics, technology"), ["technology", "politics"]);
  assert.deepEqual(parseCategories("technology"), ["technology"]);
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
  const out = parsePrefs({ categories: "technology", region: "both", frequency: "weekly" });
  assert.deepEqual(out, { prefs: { categories: ["technology"], region: "both", frequency: "weekly" } });
  const junk = parsePrefs({ categories: "technology", region: "mars", frequency: "hourly" });
  assert.deepEqual(junk, { prefs: { categories: ["technology"], region: "nigeria", frequency: "daily" } });
});

test("prefsFromRow falls back for legacy rows", () => {
  assert.deepEqual(prefsFromRow({}), { categories: ["business"], region: "nigeria", frequency: "daily" });
  assert.deepEqual(prefsFromRow({ categories: "", region: "global" }).categories, ["business"]);
});

test("only Business, Technology and Politics are offered", () => {
  assert.deepEqual(CATEGORIES.map((c) => c.id), ["business", "technology", "politics"]);
});

test("stored rows with the retired Sports and Entertainment read safely", () => {
  assert.deepEqual(prefsFromRow({ categories: "sports,entertainment" }).categories, ["business"]);
  assert.deepEqual(prefsFromRow({ categories: "business,sports" }).categories, ["business"]);
  assert.deepEqual(prefsFromRow({ categories: "sports,politics" }).categories, ["politics"]);
  assert.deepEqual(parsePrefs({ categories: ["sports"] }), { error: "Choose at least one kind of news." });
});

test("comboKey ignores region when only Business is chosen", () => {
  assert.equal(comboKey({ categories: ["business"], region: "global" }), comboKey({ categories: ["business"], region: "nigeria" }));
  assert.notEqual(comboKey({ categories: ["politics"], region: "global" }), comboKey({ categories: ["politics"], region: "nigeria" }));
});

test("editions and headline categories", () => {
  assert.deepEqual(editionsFor("both"), ["nigeria", "global"]);
  assert.deepEqual(editionsFor("global"), ["global"]);
  assert.deepEqual(headlineCategories({ categories: ["business", "technology"] }), ["technology"]);
  assert.deepEqual(HEADLINE_CATEGORIES, ["technology", "politics"]);
});

test("describePrefs reads naturally", () => {
  assert.equal(describePrefs({ categories: ["business"], region: "global", frequency: "daily" }), "Business, every morning");
  assert.equal(
    describePrefs({ categories: ["business", "technology", "politics"], region: "both", frequency: "weekly" }),
    "Business, Technology and Politics (Nigeria + Global), once a week",
  );
});
