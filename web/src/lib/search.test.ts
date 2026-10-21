import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scoreText, search, group, type Entry } from "./search.ts";
import { alertId, cleanAlerts } from "./alerts.ts";

describe("search scoring", () => {
  test("exact > prefix > word start > substring > subsequence", () => {
    const exact = scoreText("Dangote", "dangote");
    const prefix = scoreText("Dangote Cement", "dangote");
    const word = scoreText("Aliko Dangote", "dangote");
    const sub = scoreText("Xdangote", "dangote");
    const seq = scoreText("Dangote", "dngte");
    assert.ok(exact > prefix && prefix > word && word > sub && sub > seq && seq > 0);
  });
  test("ignores accents and case, requires 3+ chars for subsequence", () => {
    assert.ok(scoreText("Société Générale", "societe") > 0);
    assert.equal(scoreText("Dangote", "dg"), 0);
    assert.equal(scoreText("anything", ""), 0);
  });
  test("multi-word queries match words anywhere", () => {
    assert.ok(scoreText("Femi Otedola owns 27.49% of First HoldCo", "otedola holdco") > 0);
  });
  test("people and companies outrank stories mentioning them", () => {
    const entries: Entry[] = [
      { t: "story", l: "Otedola raises stake", s: "", u: "x" },
      { t: "entity", l: "Femi Otedola", s: "Person", u: "y" },
    ];
    assert.equal(search(entries, "otedola")[0].t, "entity");
    assert.deepEqual(group(search(entries, "otedola")).map((g) => g.type), ["entity", "story"]);
    assert.deepEqual(search(entries, "  "), []);
  });
});

describe("alerts", () => {
  test("ids are stable per URL", () => {
    assert.equal(alertId("https://a/1"), alertId("https://a/1"));
    assert.notEqual(alertId("https://a/1"), alertId("https://a/2"));
  });
  test("cleans titles, drops duplicates, newest and riskiest first", () => {
    const list = cleanAlerts([
      { date: "2026-10-20", title: "Old one - Punch", url: "u1", source: "Punch", risk_score: 90 },
      { date: "2026-10-21", title: "New one - Premium Times Nigeria", url: "u2", source: "Premium Times Nigeria", risk_score: 60 },
      { date: "2026-10-21", title: "Worse one", url: "u3", source: "Vanguard", risk_score: 80 },
      { date: "2026-10-21", title: "Worse one", url: "u3", source: "Vanguard", risk_score: 80 },
    ]);
    assert.deepEqual(list.map((a) => a.title), ["Worse one", "New one", "Old one"]);
    assert.equal(list[1].source, "Premium Times");
    assert.equal(list[0].level, "Critical");
  });
  test("the pipeline's stored level wins over the score", () => {
    const [a] = cleanAlerts([{ date: "2026-10-21", title: "EFCC arraigns four", url: "u", risk_score: 85, risk_level: "High" }]);
    assert.equal(a.level, "High");
  });
});
