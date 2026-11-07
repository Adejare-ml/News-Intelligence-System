import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { entitySummary, entityMarkdown, mdText } from "./entity-export.ts";
import { buildEntities } from "./entities.ts";
import { groupHoldings } from "./psc.ts";

const records = [
  { "Person Name": "Ada Obi", Company: "Obi Holdings Ltd", Percentage: "12%", "Nature of Control": "Ownership of shares",
    Date: "2026-10-01", "Source URL": "https://punchng.com/a", "Source Title": "Obi buys stake", Publisher: "The Punch" },
];
const [company] = buildEntities({
  holdings: groupHoldings(records),
  companies: [{ Company: "Obi Holdings Ltd", "Mention Count": 7, "Last Seen": "2026-10-03", Industry: "Finance" }],
  people: [{ Name: "Chidi Eze", Position: "CEO", Organization: "Obi Holdings Ltd", Event: "appointment", Date: "2026-09-30" }],
  articles: [{ Time: "2026-10-02T08:00:00Z", Title: "Obi Holdings expands - The Punch", Source: "The Punch", URL: "https://punchng.com/b", Entities: "Obi Holdings Ltd" }],
  contracts: [],
}).filter((e) => e.kind === "company");

describe("entity Markdown export", () => {
  test("the summary line matches the page's lede", () => {
    assert.equal(entitySummary(company), "1 reported holder with significant control.");
  });

  test("it carries the page's facts and links back to the page", () => {
    const md = entityMarkdown(company, { pageUrl: "https://aura.test/entity/obi-holdings-ltd/", entityUrl: (s) => `https://aura.test/entity/${s}/` });
    assert.match(md, /^# Obi Holdings Ltd\n/);
    assert.match(md, /Company or body · Finance/);
    assert.match(md, /- Mentions tracked: 7/);
    assert.match(md, /- Last seen: 3 Oct 2026/);
    assert.match(md, /\[Ada Obi\]\(https:\/\/aura\.test\/entity\/ada-obi\/\) owns 12% of Obi Holdings Ltd/);
    assert.match(md, /Reported by \[The Punch\]\(https:\/\/punchng\.com\/a\)/);
    assert.match(md, /\[Obi Holdings expands\]\(https:\/\/punchng\.com\/b\) · The Punch · 2 Oct 2026/);
    assert.match(md, /\*\*Chidi Eze\*\*, CEO/);
    assert.match(md, /Not a CAC filing/);
    assert.match(md, /Source page: https:\/\/aura\.test\/entity\/obi-holdings-ltd\//);
  });

  test("Markdown control characters in names are escaped", () => {
    assert.equal(mdText("[click](javascript:x) *bold*"), "\\[click\\](javascript:x) \\*bold\\*");
  });

  test("link targets with brackets or spaces stay one link", () => {
    const e = { ...company, articles: [{ Title: "A", Source: "S", URL: "https://x.test/a (b)" }] };
    const md = entityMarkdown(e, { pageUrl: "p", entityUrl: (s) => s });
    assert.match(md, /\[A\]\(https:\/\/x\.test\/a%20%28b%29\)/);
  });
});
