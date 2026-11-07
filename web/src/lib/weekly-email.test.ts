import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapBlocks } from "./weekly-email.ts";

test("wrapBlocks keeps headings and bullets, drops title, dates and footer", () => {
  const md = "# AURA Weekly Wrap\n**Week:** a to b\n\n## The week in numbers\n- **Procurement awards:** 27\n- plain line\n\n## Empty\n\n---\n*Compiled automatically.*";
  assert.deepEqual(wrapBlocks(md), [
    { heading: "The week in numbers", lines: [{ bold: "Procurement awards:", rest: "27" }, { bold: "", rest: "plain line" }] },
  ]);
  assert.deepEqual(wrapBlocks(""), []);
});

test("wrapBlocks drops the pipeline's own counters and old 'None' values", () => {
  const md = "## The week in numbers\n- **Pipeline runs:** 27\n- **Articles processed:** 224\n- **LLM cascade failures:** 2\n- **High-risk signals:** 17\n\n## Procurement recorded this week\n- 2026-11-01 — FG → None (None): Road\n- 2026-10-30 — FG → Acme (N2bn): Bridge";
  assert.deepEqual(wrapBlocks(md), [
    { heading: "The week in numbers", lines: [{ bold: "High-risk signals:", rest: "17" }] },
    { heading: "Procurement recorded this week", lines: [
      { bold: "", rest: "2026-11-01 — FG (amount undisclosed): Road" },
      { bold: "", rest: "2026-10-30 — FG → Acme (N2bn): Bridge" },
    ] },
  ]);
});
