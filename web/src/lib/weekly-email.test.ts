import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapBlocks } from "./weekly-email.ts";

test("wrapBlocks keeps headings and bullets, drops title, dates and footer", () => {
  const md = "# AURA Weekly Wrap\n**Week:** a to b\n\n## The week in numbers\n- **Pipeline runs:** 27\n- plain line\n\n## Empty\n\n---\n*Compiled automatically.*";
  assert.deepEqual(wrapBlocks(md), [
    { heading: "The week in numbers", lines: [{ bold: "Pipeline runs:", rest: "27" }, { bold: "", rest: "plain line" }] },
  ]);
  assert.deepEqual(wrapBlocks(""), []);
});
