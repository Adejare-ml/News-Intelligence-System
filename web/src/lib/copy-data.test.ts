import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dirname, "../../scripts/copy-data.mjs");

test("copy-data publishes the exports but not the list of unpublished names", () => {
  const work = mkdtempSync(join(tmpdir(), "aura-copy-"));
  try {
    const src = join(work, "src");
    const dest = join(work, "dest");
    mkdirSync(join(src, "archives"), { recursive: true });
    writeFileSync(join(src, "latest.json"), "[]");
    writeFileSync(join(src, "archives", "a.json"), "[]");
    writeFileSync(join(src, "suppressed.json"), '[{"name":"Tolu Bakare","reason":"dispute upheld"}]');
    execFileSync(process.execPath, [script], { env: { ...process.env, COPY_DATA_SRC: src, COPY_DATA_DEST: dest }, stdio: "ignore" });
    assert.ok(existsSync(join(dest, "latest.json")));
    assert.ok(existsSync(join(dest, "archives", "a.json")));
    // Serving it would point readers straight at the people who asked to come off.
    assert.equal(existsSync(join(dest, "suppressed.json")), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
