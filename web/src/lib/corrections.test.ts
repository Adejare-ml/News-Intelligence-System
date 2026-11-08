import { test } from "node:test";
import assert from "node:assert/strict";
import { readCorrections } from "./corrections.ts";

test("the corrections log is newest first and skips entries missing a date or a change", () => {
  const log = readCorrections([
    { date: "2026-11-01", ref: "Ikeja Mills", what_changed: "Stake corrected from 60% to 6%", reason: "Misread figure" },
    { date: "2026-11-05", ref: "", what_changed: "Record removed", reason: "" },
    { date: "", what_changed: "No date" },
    { date: "2026-11-03", what_changed: "  " },
    "junk",
    null,
  ]);
  assert.deepEqual(log, [
    { date: "2026-11-05", ref: "", what_changed: "Record removed", reason: "" },
    { date: "2026-11-01", ref: "Ikeja Mills", what_changed: "Stake corrected from 60% to 6%", reason: "Misread figure" },
  ]);
});

test("anything but a list is an empty log", () => {
  assert.deepEqual(readCorrections({}), []);
  assert.deepEqual(readCorrections(null), []);
});
