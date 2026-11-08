import { test } from "node:test";
import assert from "node:assert/strict";
import { GLOSSARY, termId } from "./glossary.ts";

test("every glossary term has its expansion and a plain-English definition", () => {
  assert.deepEqual(Object.keys(GLOSSARY).sort(), ["BPP", "CAC", "CAMA", "PSC"]);
  for (const [term, entry] of Object.entries(GLOSSARY)) {
    assert.ok(entry.expansion.length > term.length, term);
    assert.ok(entry.definition.endsWith("."), term);
  }
  assert.equal(GLOSSARY.PSC.expansion, "Person with significant control");
  assert.match(GLOSSARY.PSC.definition, /5%/);
  assert.match(GLOSSARY.CAMA.expansion, /2020/);
});

test("each use of a term gets its own element id", () => {
  const a = termId("PSC");
  const b = termId("PSC");
  assert.notEqual(a, b);
  assert.match(a, /^term-psc-\d+$/);
});
