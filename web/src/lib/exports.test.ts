import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { registerCsv, procurementCsv, newsCsv } from "./exports.ts";
import { toContract } from "./procurement.ts";

const lines = (csv: string) => csv.trimEnd().split("\r\n");

describe("downloads", () => {
  test("the register CSV carries published rows only", () => {
    const csv = registerCsv([
      { "Person Name": "Ada Obi", Company: "Obi Holdings Ltd", Percentage: "12%", "Nature of Control": "Ownership of shares",
        Date: "2026-10-01", "Source URL": "https://punchng.com/a", "Source Title": "Obi buys stake", Publisher: "The Punch" },
      { "Person Name": "Hidden Unsourced", Company: "Nope Ltd", "Source URL": "" },
      { "Person Name": "Hidden Quarantined", Company: "Nope Ltd", "Source URL": "https://x.test/b", Quarantined: true },
    ]);
    const rows = lines(csv);
    assert.equal(rows[0], "Person,Company,Stake,Nature of control,Board role,Change,Reported,Source title,Publisher,Source URL");
    assert.equal(rows.length, 2);
    assert.match(rows[1], /^Ada Obi,Obi Holdings Ltd,12%,Ownership of shares,,,2026-10-01,Obi buys stake,The Punch,https:\/\/punchng.com\/a$/);
    assert.ok(!csv.includes("Hidden"));
  });

  test("the procurement CSV uses the cleaned contract fields", () => {
    const csv = procurementCsv([
      toContract({ Agency: "BPP", Contractor: "None", Project: "Road works - Vanguard", Source: "Vanguard", Date: "2026-10-02T09:00:00Z",
        "Amount Value": 4_250_000_000, "Amount Currency": "NGN" }),
    ]);
    const rows = lines(csv);
    assert.equal(rows[0], "Project,Agency,Contractor,Amount,Currency,Amount (as reported),Publisher,Date");
    assert.equal(rows[1], "Road works,BPP,,4250000000,NGN,₦4.25bn,Vanguard,2026-10-02");
  });

  test("the news CSV is one row per article, with injection-guarded headlines", () => {
    const csv = newsCsv([
      { Time: "2026-11-06T00:51:20Z", Title: "=FG vows completion", Source: "The Punch", URL: "https://punchng.com/x",
        Category: "Government", "Risk Score": 25, "Risk Level": "Low", Entities: "Federal Government|Tunji Alausa", Summary: "Short." },
    ]);
    const rows = lines(csv);
    assert.equal(rows[0], "Published,Headline,Publisher,URL,Category,Risk score,Risk level,Entities,Summary");
    assert.equal(rows[1], "2026-11-06T00:51:20Z,'=FG vows completion,The Punch,https://punchng.com/x,Government,25,Low,Federal Government; Tunji Alausa,Short.");
  });

  test("the news CSV writes every Published date as ISO so spreadsheets can sort it", () => {
    const csv = newsCsv([
      { Time: "Fri, 06 Nov 2026 17:55:52 GMT", Title: "Feed date" },
      { Time: "2026-11-05 08:00:00", Title: "Runner date" },
      { Time: "sometime", Title: "Unparseable" },
    ]);
    const published = lines(csv).slice(1).map((r) => r.split(",")[0]);
    assert.deepEqual(published, ["2026-11-06T17:55:52Z", "2026-11-05T08:00:00Z", "sometime"]);
  });
});
