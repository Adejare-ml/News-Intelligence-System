import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFunnel } from "./funnel.ts";

test("the funnel narrows from articles to holdings and explains the gap", () => {
  const f = buildFunnel({
    sources: [{ total: 2632 }, { total: 1000 }],
    days: [{ articles: 308 }, { articles: 25 }],
    gate: { checked: 25, published: 17 },
    holdings: 7,
    roles: 5,
  }, "Jul 2026");
  assert.deepEqual(f.map((s) => s.value), [3632, 333, 25, 7]);
  assert.equal(f[0].hint, "Nigerian business news since Jul 2026");
  assert.equal(f[3].hint, "8 withheld by the checks · plus 5 board roles");
});

test("an empty pipeline still shows the register step, never a wall of zeros", () => {
  const f = buildFunnel({ sources: [], days: [], gate: {}, holdings: 0, roles: 0 });
  assert.equal(f.length, 1);
  assert.equal(f[0].label, "On the register");
});
