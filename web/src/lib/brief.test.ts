import { test } from "node:test";
import assert from "node:assert/strict";
import { parseItem, parseBrief, splitCitations } from "./brief.ts";

const long = "https://news.google.com/rss/articles/CBMixwFBVV95cUxPSkF6?oc=5";

test("citations in every shape the model writes are pulled out of the text", () => {
  const cases: [string, { name: string; url: string }[]][] = [
    [`Seplat named a CEO ([Premium Times Nigeria](${long})).`, [{ name: "Premium Times Nigeria", url: long }]],
    [`Seplat named a CEO. ([The Punch](https://punchng.com/a/))`, [{ name: "The Punch", url: "https://punchng.com/a/" }]],
    [`Seplat named a CEO ([The Punch](https://punchng.com/a/))))`, [{ name: "The Punch", url: "https://punchng.com/a/" }]],
    ["NIMASA seized four vessels ({source: Vanguard News}).", [{ name: "Vanguard News", url: "" }]],
    ["Assemblies create state police ({source: Premium Times Nigeria}&{source: Premium Times Nigeria}).", [{ name: "Premium Times Nigeria", url: "" }]],
    ["Two outlets ([A](https://a.ng/1); [B](https://b.ng/2)).", [{ name: "A", url: "https://a.ng/1" }, { name: "B", url: "https://b.ng/2" }]],
  ];
  for (const [line, sources] of cases) {
    const out = splitCitations(line);
    assert.deepEqual(out.sources, sources, line);
    assert.ok(!/\[|\]\(|\{source/.test(out.body), `left a citation in: ${out.body}`);
    assert.match(out.body, /[.!?]$/);
  }
});

test("a bullet without a citation is left alone", () => {
  assert.deepEqual(splitCitations("No PSC disclosures were reported."), { body: "No PSC disclosures were reported.", sources: [] });
});

test("parseItem: plain text has no markdown and the HTML no citation", () => {
  const item = parseItem(`* Seplat Energy declared Effiong Okon as its new CEO ([Premium Times Nigeria](${long})).`);
  assert.equal(item.lead, "");
  assert.equal(item.rest, "Seplat Energy declared Effiong Okon as its new CEO.");
  assert.equal(item.source?.name, "Premium Times Nigeria");
  assert.ok(!item.html.includes("news.google.com"));
  const bold = parseItem("* **Executive order yields N212bn**. The order raised N211.74bn. ([The Punch](https://punchng.com/x/))");
  assert.equal(bold.lead, "Executive order yields N212bn");
  assert.equal(bold.rest, "The order raised N211.74bn.");
});

test("parseBrief keeps sections and their sources", () => {
  const md = "# T\n### Key Developments\n* A happened ({source: Vanguard News}).\n### High Risk Alerts\n* B happened ([X](https://x.ng/b)).\n";
  const b = parseBrief(md);
  assert.deepEqual(b.sections.map((s) => s.title), ["Key Developments", "High Risk Alerts"]);
  assert.equal(b.sections[0].items[0].sources[0].name, "Vanguard News");
});
