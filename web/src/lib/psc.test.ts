import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBand, flagsFor, buildContext, controlChain, groupHoldings, summarise, describeHolding, isPublic,
} from "./psc.ts";

describe("Nigerian disclosure bands (CAMA 2020 s.868)", () => {
  test("classifies the four disclosable bands", () => {
    assert.equal(classifyBand("81.4%")?.id, "BAND_75_100");
    assert.equal(classifyBand("63.2%")?.id, "BAND_50_75");
    assert.equal(classifyBand("28.5%")?.id, "BAND_25_50");
    assert.equal(classifyBand("6.8%")?.id, "BAND_5_25");
  });
  test("uses 5% as the threshold, not the UK/FATF 25%", () => {
    assert.equal(classifyBand("5%")?.id, "BAND_5_25");
    assert.equal(classifyBand("4.99%")?.id, "BELOW_THRESHOLD");
    assert.equal(classifyBand("24%")?.id, "BAND_5_25");
  });
  test("returns null when nothing was disclosed", () => {
    for (const v of [null, "", "N/A", undefined]) assert.equal(classifyBand(v), null);
  });
  test("accepts bare numbers", () => {
    assert.equal(classifyBand(28.5)?.id, "BAND_25_50");
    assert.equal(classifyBand(0)?.id, "BELOW_THRESHOLD");
  });
});

describe("Patterns worth checking", () => {
  const ids = (rec: Record<string, unknown>, all = [rec]) => flagsFor(rec, buildContext(all)).map((f) => f.id);

  test("voting rights materially above equity", () => {
    assert.ok(ids({ "Person Name": "A", Company: "C", "Direct %": "11%", "Indirect %": "52.2%", "Voting Rights %": "88%" })
      .includes("R3_VOTING_MISMATCH"));
    assert.ok(!ids({ "Person Name": "A", Company: "C", "Direct %": "40%", "Indirect %": "38%", "Voting Rights %": "78%" })
      .includes("R3_VOTING_MISMATCH"));
  });
  test("secrecy-jurisdiction vehicle, but not a domestic one", () => {
    assert.ok(ids({ "Person Name": "A", Company: "C", "Intermediate Entities": "Meridian Trust (Mauritius) Limited" })
      .includes("R7_SECRECY_VEHICLE"));
    assert.ok(!ids({ "Person Name": "A", Company: "C", "Intermediate Entities": "Harmattan Industries Limited" })
      .includes("R7_SECRECY_VEHICLE"));
  });
  test("sub-threshold only when several holders sit under 5%", () => {
    const a = { "Person Name": "A", Company: "Sahel", Percentage: "4.7%" };
    const b = { "Person Name": "B", Company: "Sahel", Percentage: "4.9%" };
    assert.ok(ids(a, [a, b]).includes("R1_SUB_THRESHOLD"));
    assert.ok(!ids({ "Person Name": "C", Company: "Solo", Percentage: "4.7%" }).includes("R1_SUB_THRESHOLD"));
  });
  test("politically exposed holder", () => {
    assert.ok(ids({ "Person Name": "A", Company: "C", "PEP Status": "Yes - PEP" }).includes("R9_PEP"));
    assert.ok(!ids({ "Person Name": "A", Company: "C", "PEP Status": "No" }).includes("R9_PEP"));
  });
  test("cross-entity counts distinct companies, not rows", () => {
    const one = { "Person Name": "Ada", Company: "X" };
    assert.ok(ids(one, [one, { "Person Name": "Ada", Company: "Y" }]).includes("R12_CROSS_ENTITY"));
    assert.ok(!ids(one, [one, { ...one }, { ...one }]).includes("R12_CROSS_ENTITY"));
  });
  test("high severity ranks first", () => {
    const rec = { "Person Name": "Ada", Company: "C", "Intermediate Entities": "Nominee (Cayman) Ltd" };
    const flags = flagsFor(rec, buildContext([rec, { "Person Name": "Ada", Company: "D" }]));
    assert.equal(flags[0].severity, "high");
  });
  test("never throws on empty or malformed records", () => {
    assert.deepEqual(flagsFor(null), []);
    flagsFor({}, buildContext([{}]));
    flagsFor({ Percentage: "banana" }, buildContext([{}]));
  });
});

describe("Control chain", () => {
  test("two steps for a direct holding", () => {
    assert.equal(controlChain({ "Person Name": "Ada", Company: "X", "Intermediate Entities": "Direct Holding" }).length, 2);
  });
  test("inserts the vehicle when one exists", () => {
    const chain = controlChain({ "Person Name": "Ada", Company: "X", "Intermediate Entities": "Meridian (Mauritius) Ltd" });
    assert.deepEqual(chain.map((s) => s.kind), ["person", "vehicle", "company"]);
  });
});

describe("Holdings grouped from repeated reports", () => {
  const reports = [
    { "Person Name": "Femi Otedola", Company: "First HoldCo", Date: "2026-08-05", Percentage: "", "Nature of Control": "Significant influence or control" },
    { "Person Name": "Femi Otedola", Company: "First HoldCo", Date: "2026-08-17", Percentage: "27.49%", "Nature of Control": "Ownership of shares 25-50%" },
    { "Person Name": "Femi Otedola", Company: "First HoldCo", Date: "2026-08-26", Percentage: "", "Nature of Control": "Ownership of shares" },
    { "Person Name": "Babs Ogundeyi", Company: "Kuda", Date: "2026-10-14", Percentage: "" },
  ].map((r) => ({ Source: "extracted", "Source URL": "https://punchng.com/report/", ...r }));

  test("one holding per holder and company", () => {
    const h = groupHoldings(reports);
    assert.equal(h.length, 2);
    const otedola = h.find((x) => x.person === "Femi Otedola")!;
    assert.equal(otedola.reports.length, 3);
    assert.equal(otedola.firstReported, "2026-08-05");
    assert.equal(otedola.lastReported, "2026-08-26");
  });
  test("keeps the latest disclosed stake even when a later report omits it", () => {
    const otedola = groupHoldings(reports).find((x) => x.person === "Femi Otedola")!;
    assert.equal(otedola.stake, 27.49);
    assert.equal(otedola.stakeLabel, "27.49%");
    assert.equal(otedola.band?.id, "BAND_25_50");
    assert.equal(describeHolding(otedola), "owns 27.49% of First HoldCo");
  });
  test("a stake in any report clears 'interest not quantified'", () => {
    const otedola = groupHoldings(reports).find((x) => x.person === "Femi Otedola")!;
    assert.ok(!otedola.flags.some((f) => f.id === "R6_UNKNOWN_OWNER"));
  });
  test("an undisclosed stake reads plainly", () => {
    const kuda = groupHoldings(reports).find((x) => x.company === "Kuda")!;
    assert.equal(kuda.stake, null);
    assert.equal(kuda.stakeLabel, "Stake not disclosed");
  });
  test("summary counts holdings, not rows, and separates patterns from high severity", () => {
    const s = summarise(groupHoldings(reports));
    assert.equal(s.holdings, 2);
    assert.equal(s.withStake, 1);
    assert.ok(s.highSeverity <= s.withPattern);
    assert.equal(s.isDemo, false);
  });
  test("spacing and punctuation do not split a company", () => {
    const h = groupHoldings([
      { "Person Name": "Femi Otedola", Company: "First HoldCo", Date: "2026-08-17", Source: "extracted", "Source URL": "https://punchng.com/report/" },
      { "Person Name": "Femi Otedola", Company: "FirstHoldCo", Date: "2026-08-11", Source: "extracted", "Source URL": "https://punchng.com/report/" },
    ]);
    assert.equal(h.length, 1);
  });
  test("placeholder roles are not shown", () => {
    const [h] = groupHoldings([{ "Person Name": "Aliko Dangote", Company: "Dangote Refinery", "Board Role": "null", Source: "extracted", "Source URL": "https://punchng.com/report/" }]);
    assert.equal(h.role, "");
  });
  test("canonical keys from the validation gate merge spelling variants", () => {
    const h = groupHoldings([
      { "Person Name": "Alhaji Aliko Dangote", "Person Key": "aliko dangote", Company: "Dangote Petroleum Refinery", "Company Key": "dangote refinery", Date: "2026-09-17", Source: "extracted", "Source URL": "https://punchng.com/report/" },
      { "Person Name": "Aliko Dangote", "Person Key": "aliko dangote", Company: "Dangote Refinery", "Company Key": "dangote refinery", Date: "2026-09-30", Source: "extracted", "Source URL": "https://punchng.com/report/" },
      { "Person Name": "Aliko Dangote", "Person Key": "aliko dangote", Company: "Dangote Cement", "Company Key": "dangote cement", Date: "2026-01-15", Source: "extracted", "Source URL": "https://punchng.com/report/" },
    ]);
    assert.equal(h.length, 2);
    assert.ok(h.every((x) => x.person === "Aliko Dangote"), "one spelling per holder");
    assert.equal(h.find((x) => x.reports.length === 2)?.company, "Dangote Refinery");
  });
  test("only publishable rows become holdings: unsourced and quarantined rows never render", () => {
    const h = groupHoldings([
      { "Person Name": "Sadio Mané", Company: "Mango Business", Quarantined: true, Source: "extracted", "Source URL": "https://punchng.com/report/" },
      { "Person Name": "Jubril Adewale Tinubu", Company: "Oando Plc", Percentage: "66.7%", Source: "" },
      { "Person Name": "Femi Otedola", Company: "Geregu Power Plc", Percentage: "78.6%" },
      { "Person Name": "Femi Otedola", Company: "First HoldCo", Percentage: "27.49%", Source: "extracted", "Source URL": "https://punchng.com/report/" },
    ]);
    assert.deepEqual(h.map((x) => `${x.person}/${x.company}`), ["Femi Otedola/First HoldCo"]);
    assert.equal(isPublic({ "Person Name": "A", Company: "B", Source: "null" }), false);
    assert.equal(isPublic({ "Person Name": "A", Company: "B", Source: "seed" }), false, "a label is not a source");
    assert.equal(isPublic({ "Person Name": "A", Company: "B", Source: "extracted" }), false, "every live row looked like this");
    assert.equal(isPublic({ "Person Name": "A", Company: "B", Source: "extracted", "Source URL": "https://punchng.com/a/" }), true);
  });
  test("bare board roles are shown but not counted as holdings", () => {
    const h = groupHoldings([
      { "Person Name": "Thomas Ogungbangbe", Company: "CITA Energies", "Board Role": "Chairman", "Nature of Control": "Significant influence or control", Source: "extracted", "Source URL": "https://punchng.com/report/" },
      { "Person Name": "Femi Otedola", Company: "First HoldCo", Percentage: "27.49%", Source: "extracted", "Source URL": "https://punchng.com/report/" },
    ]);
    assert.equal(h.length, 2);
    const cita = h.find((x) => x.company === "CITA Energies")!;
    assert.equal(cita.kind, "role");
    assert.equal(describeHolding(cita), "is chairman of CITA Energies");
    const s = summarise(h);
    assert.equal(s.holdings, 1);
    assert.equal(s.roles, 1);
  });
  test("empty register", () => {
    const s = summarise(groupHoldings([]));
    assert.equal(s.holdings, 0);
    assert.equal(s.filingRefRate, null);
  });
});
