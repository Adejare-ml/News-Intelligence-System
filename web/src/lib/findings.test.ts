import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isFindingFile, publishableFindings, whatsappHref, type Finding } from "./findings.ts";

const sourced = {
  "Person Name": "Tony Elumelu", Company: "Seplat", "Source URL": "https://punchng.com/a/", Quarantined: false,
};
const withheld = { "Person Name": "Zed Unsourced", Company: "Hidden Holdings Ltd", "Source URL": "" };

function finding(over: Partial<Finding> = {}): Finding {
  return {
    week: "2026-W45",
    headline: "Who is behind Seplat?",
    note: "",
    ref: "seplat",
    names_person: true,
    link: "https://auranews.pages.dev/findings/2026-W45/",
    bullets: [
      { kind: "register", text: "Tony Elumelu is reported to control Seplat", outlet: "The Punch", url: "https://punchng.com/a/", date: "2026-08-21" },
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

  test("drops malformed files instead of breaking the build", () => {
    const broken = [null, { week: "soon" }, finding({ bullets: undefined as never })] as unknown as Finding[];
    assert.deepEqual(publishableFindings(broken, [sourced]), []);
  });

  test("WhatsApp share link carries the text, encoded", () => {
    assert.equal(whatsappHref("A & B https://x.test/"), "https://wa.me/?text=A%20%26%20B%20https%3A%2F%2Fx.test%2F");
  });
});
