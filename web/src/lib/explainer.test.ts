import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPLAINER_KEY, saveClosed } from "./explainer.ts";

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  };
}

test("closing the explainer is remembered and reopening forgets it", () => {
  const s = memory();
  saveClosed(() => s, true);
  assert.equal(s.getItem(EXPLAINER_KEY), "closed");
  saveClosed(() => s, false);
  assert.equal(s.getItem(EXPLAINER_KEY), null);
});

test("blocked storage never throws, even when reaching it throws", () => {
  const blocked = (): Storage => { throw new Error("SecurityError"); };
  assert.doesNotThrow(() => saveClosed(blocked, true));
  const readOnly = { setItem() { throw new Error("QuotaExceededError"); } } as unknown as Storage;
  assert.doesNotThrow(() => saveClosed(() => readOnly, true));
});
