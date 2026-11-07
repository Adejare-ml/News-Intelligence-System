import { test } from "node:test";
import assert from "node:assert/strict";
import { hiddenNames, namesHidden, scrubDigest, withoutHidden, withoutHiddenLines } from "./suppressed.ts";

test("hidden names come from the owner's list and skip junk entries", () => {
  assert.deepEqual(hiddenNames([{ name: " Tolu Bakare " }, { name: "" }, "junk", null, { reason: "x" }]), ["Tolu Bakare"]);
  assert.deepEqual(hiddenNames({ not: "a list" }), []);
});

test("a value names a hidden entity by whole words, ignoring case (the pipeline's rule)", () => {
  const hidden = ["Aliko Dangote"];
  assert.equal(namesHidden({ "Person Name": "Alhaji ALIKO Dangote" }, hidden), true);
  assert.equal(namesHidden("Dangote Cement", hidden), false);
  assert.equal(namesHidden("Aliko Dangotes", hidden), false);
  assert.equal(namesHidden("Aliko Dangote", []), false);
});

test("variants the register treats as one entity are hidden too (the pipeline's canonical keys)", () => {
  assert.equal(namesHidden("Tony O. Elumelu", ["Tony Elumelu"]), true);
  assert.equal(namesHidden("Tony Elumelu", ["Chief Tony O. Elumelu"]), true);
  assert.equal(namesHidden("Profits at Dangote Cement rise", ["Dangote Cement Plc"]), true);
  assert.equal(namesHidden({ Company: "Dangote Petroleum Refinery" }, ["Dangote Refinery"]), true);
  assert.equal(namesHidden({ "Person Name": "Zedekiah Q. Varianttest" }, ["Zedekiah Varianttest"]), true);
  assert.equal(namesHidden({ Entities: "First Bank|Sentinel Mills" }, ["Sentinel Mills Ltd"]), true);
  // A company key that shrinks to one common word is used for whole values only.
  assert.equal(namesHidden("Banks widen access to credit", ["Access Holdings"]), false);
  assert.equal(namesHidden({ Company: "Access" }, ["Access Holdings"]), true);
  // One field never runs into the next: "Ann" then "Other" is not "Ann Other".
  assert.equal(namesHidden({ First: "Ann", Last: "Other" }, ["Ann Other"]), false);
});

test("rows naming a hidden entity anywhere are dropped", () => {
  const rows = [{ Company: "Ikeja Mills" }, { Title: "Results", Entities: "First Bank|Ikeja Mills" }, { Company: "First Bank" }];
  assert.deepEqual(withoutHidden(rows, ["Ikeja Mills"]), [{ Company: "First Bank" }]);
  assert.equal(withoutHidden(rows, []), rows);
});

test("brief markdown loses only the lines that name a hidden entity", () => {
  const md = "# Brief\n\n- Tolu Bakare takes Ikeja Mills\n- CBN holds rates\n";
  assert.equal(withoutHiddenLines(md, ["Tolu Bakare"]), "# Brief\n\n- CBN holds rates\n");
  assert.equal(withoutHiddenLines(md, []), md);
});

test("the email digest loses cards, lines and a subject that name a hidden entity", () => {
  const digest = {
    edition: "1",
    subject: "Tolu Bakare takes Ikeja Mills",
    preheader: "Tolu Bakare and more",
    cards: [{ n: 1, headline: "Tolu Bakare takes Ikeja Mills" }, { n: 2, headline: "CBN holds rates" }],
    overview: [{ text: "Tolu Bakare moved", card: 1 }],
    insights: [],
    also: [{ text: "CBN" }],
    psc: [{ text: "Chief Tolu Bakare holds 60%" }],
    stats: { stories: 2 },
  };
  const out = scrubDigest(digest, ["Tolu Bakare"]);
  assert.deepEqual(out.cards, [{ n: 2, headline: "CBN holds rates" }]);
  assert.deepEqual([out.overview, out.psc, out.also], [[], [], [{ text: "CBN" }]]);
  assert.equal(out.subject, "AURA Morning Brief");
  assert.equal(out.preheader, "");
  assert.doesNotMatch(JSON.stringify(out), /Tolu Bakare/);
  assert.equal(scrubDigest(digest, []), digest);
});
