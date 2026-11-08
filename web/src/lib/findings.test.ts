import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFindingFile, publishableFindings, weekStart, whatsappHref, type Finding } from "./findings.ts";

/**
 * data.findings() on a data folder of its own: data.ts reads AURA_DATA_DIR
 * once, when it loads, so each call loads a fresh copy of the module.
 */
let loads = 0;
async function loadFindings(files: Record<string, unknown>): Promise<Finding[]> {
  const dir = mkdtempSync(join(tmpdir(), "aura-findings-"));
  try {
    mkdirSync(join(dir, "findings"));
    for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
    process.env.AURA_DATA_DIR = dir;
    const data = await import(`./data.ts?load=${++loads}`);
    return data.findings();
  } finally {
    delete process.env.AURA_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

const sourced = {
  "Person Name": "Tony Elumelu", Company: "Seplat", Confidence: "Full article", "Source URL": "https://punchng.com/a/", Quarantined: false,
};
const withheld = { "Person Name": "Zed Unsourced", Company: "Hidden Holdings Ltd", Confidence: "Full article", "Source URL": "" };

function finding(over: Partial<Finding> = {}): Finding {
  return {
    week: "2026-W45",
    headline: "Who is behind Seplat?",
    note: "",
    ref: "seplat",
    names_person: true,
    link: "https://auranews.pages.dev/findings/2026-W45/",
    bullets: [
      { kind: "register", text: "Tony Elumelu is reported to control Seplat", outlet: "The Punch", url: "https://punchng.com/a/", date: "2026-08-21",
        record: { person: "tony elumelu", company: "seplat" } },
      { kind: "news", text: "BusinessDay reported: \"Seplat output rises\"", outlet: "BusinessDay", url: "https://businessday.ng/b/", date: "2026-11-02" },
    ],
    drafts: { linkedin: "l", x: "x", email: { subject: "s", body: "b" } },
    ...over,
  };
}

describe("findings", () => {
  test("only <week>.json files are findings, not the owner's picks", () => {
    assert.equal(isFindingFile("2026-W45.json"), true);
    assert.equal(isFindingFile("picks.json"), false);
    assert.equal(isFindingFile("2026-45.json"), false);
  });

  test("keeps findings backed by today's register, newest week first", () => {
    const out = publishableFindings([finding({ week: "2026-W09" }), finding()], [sourced, withheld]);
    assert.deepEqual(out.map((f) => f.week), ["2026-W45", "2026-W09"]);
  });

  test("drops a finding whose register fact the gate no longer publishes", () => {
    // The row lost its source link after the draft was merged.
    const out = publishableFindings([finding()], [{ ...sourced, "Source URL": "" }]);
    assert.deepEqual(out, []);
  });

  test("drops a finding that names anyone or anything only in withheld rows", () => {
    const named = finding({ note: "Zed Unsourced is also linked." });
    const company = finding({ headline: "Hidden Holdings Ltd and Seplat" });
    assert.deepEqual(publishableFindings([named, company], [sourced, withheld]), []);
  });

  test("drops a finding whose own row is withheld even when another published row shares its link", () => {
    // One article backs two rows; the gate quarantined the Elumelu/Seplat one.
    // Both names stay published through other rows, so only the record match can catch it.
    const sameArticle = { "Person Name": "Femi Otedola", Company: "Seplat", Confidence: "Full article", "Source URL": "https://punchng.com/a/" };
    const elsewhere = { "Person Name": "Tony Elumelu", Company: "UBA", Confidence: "Full article", "Source URL": "https://punchng.com/uba/" };
    const out = publishableFindings([finding()], [{ ...sourced, Quarantined: true }, sameArticle, elsewhere]);
    assert.deepEqual(out, []);
  });

  test("drops a register bullet that does not say which row it stands on", () => {
    const [reg, news] = finding().bullets;
    const unkeyed = finding({ bullets: [{ ...reg, record: undefined }, news] });
    assert.deepEqual(publishableFindings([unkeyed], [sourced]), []);
  });

  test("matches withheld people by canonical key, not one spelling", () => {
    // The gate keyed this row as "quin quarantined"; the finding spells it another way.
    const quarantined = {
      "Person Name": "Alhaji Quin O. Quarantined", "Person Key": "quin quarantined", Company: "Seplat",
      Confidence: "Full article", "Source URL": "https://punchng.com/q/", Quarantined: true,
    };
    const byKey = finding({ note: "Quin Quarantined is also linked." });
    // No Person Key on an older row: the middle initial still must not hide the name.
    const unkeyed = { "Person Name": "Quin Quarantined", Company: "Seplat", Confidence: "Full article", "Source URL": "" };
    const initial = finding({ note: "Quin O. Quarantined is also linked." });
    assert.deepEqual(publishableFindings([byKey], [sourced, quarantined]), []);
    assert.deepEqual(publishableFindings([initial], [sourced, unkeyed]), []);
  });

  test("matches a withheld company by every alias spelling the gate folds into its key", () => {
    // The gate keys "FBN Holdings" and "FirstHoldCo" both as "first holdco".
    const quarantined = {
      "Person Name": "Quin Quarantined", Company: "FBN Holdings", "Company Key": "first holdco",
      Confidence: "Full article", "Source URL": "https://punchng.com/fbn/", Quarantined: true,
    };
    const alias = finding({
      headline: "Inside FirstHoldCo's new control map",
      bullets: [finding().bullets[1], { ...finding().bullets[1], url: "https://businessday.ng/c/" }],
    });
    assert.deepEqual(publishableFindings([alias], [sourced, quarantined]), []);
  });

  test("data.findings() leaves out a finding that names anyone or anything the owner unpublished", async () => {
    const news = finding().bullets[1];
    const clean = finding({ week: "2026-W44" });
    // Named only in the note, with news-only bullets: no register row to lose.
    const inNote = finding({ week: "2026-W45", note: "Alhaji Tolu O. Bakare is also linked.", bullets: [news, { ...news, url: "https://businessday.ng/c/" }] });
    // Named only in a share draft.
    const inDraft = finding({ week: "2026-W46", drafts: { ...finding().drafts, x: "Tolu Bakare and Seplat https://auranews.pages.dev/" } });
    // A company, under another spelling the register groups with it.
    const company = finding({ week: "2026-W47", headline: "Who is behind Ikeja Mills?", bullets: [news, { ...news, url: "https://businessday.ng/d/" }] });
    // The register bullet's own row names the unpublished person as previous
    // holder: the site never shows that row, so the bullet no longer stands.
    const viaRow = finding({ week: "2026-W48" });
    const out = await loadFindings({
      "suppressed.json": [{ name: "Tolu Bakare", reason: "dispute upheld" }, { name: "Ikeja Mills Plc", reason: "dispute upheld" }],
      "significant_control.json": [sourced, { ...sourced, "Previous Holder": "Tolu Bakare", "Source URL": "https://punchng.com/w48/" }],
      "findings/2026-W44.json": clean,
      "findings/2026-W45.json": inNote,
      "findings/2026-W46.json": inDraft,
      "findings/2026-W47.json": company,
      "findings/2026-W48.json": { ...viaRow, bullets: [{ ...viaRow.bullets[0], url: "https://punchng.com/w48/" }, news] },
    });
    assert.deepEqual(out.map((f) => f.week), ["2026-W44"]);
  });

  test("drops malformed files instead of breaking the build", () => {
    const broken = [null, { week: "soon" }, finding({ bullets: undefined as never })] as unknown as Finding[];
    assert.deepEqual(publishableFindings(broken, [sourced]), []);
  });

  test("WhatsApp share link carries the text, encoded", () => {
    assert.equal(whatsappHref("A & B https://x.test/"), "https://wa.me/?text=A%20%26%20B%20https%3A%2F%2Fx.test%2F");
  });

  test("weekStart returns the Monday an ISO week starts on", () => {
    assert.equal(weekStart("2026-W45"), "2026-11-02");
    assert.equal(weekStart("2026-W01"), "2025-12-29");
    assert.equal(weekStart("2021-W01"), "2021-01-04");
  });
});
