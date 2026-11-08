import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("copy-data does not publish the findings folder: the owner's picks and every draft", () => {
  const work = mkdtempSync(join(tmpdir(), "aura-copy-"));
  try {
    const src = join(work, "src");
    const dest = join(work, "dest");
    mkdirSync(join(src, "findings"), { recursive: true });
    writeFileSync(join(src, "latest.json"), "[]");
    // A file elsewhere that merely shares the name is still published.
    mkdirSync(join(src, "archives"), { recursive: true });
    writeFileSync(join(src, "archives", "findings.json"), "[]");
    // An unvetted pick, and a merged finding the build's recheck may drop:
    // the site renders findings at build, so nothing reads these at /data/.
    writeFileSync(join(src, "findings", "picks.json"), '[{"week":"2026-W45","entity":"tolu-bakare"}]');
    writeFileSync(join(src, "findings", "2026-W45.json"), '{"week":"2026-W45","headline":"Tolu Bakare and Ikeja Mills"}');
    execFileSync(process.execPath, [script], { env: { ...process.env, COPY_DATA_SRC: src, COPY_DATA_DEST: dest }, stdio: "ignore" });
    assert.ok(existsSync(join(dest, "latest.json")));
    assert.ok(existsSync(join(dest, "archives", "findings.json")));
    assert.equal(existsSync(join(dest, "findings")), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("copy-data takes an unpublished name out of the briefs and digests it publishes", () => {
  const work = mkdtempSync(join(tmpdir(), "aura-copy-"));
  try {
    const src = join(work, "src");
    const dest = join(work, "dest");
    mkdirSync(join(src, "archives"), { recursive: true });
    mkdirSync(join(src, "digests"), { recursive: true });
    const brief = "# Brief\n- Alhaji Tolu Bakare takes Ikeja Mills\n- CBN raises rates\n";
    writeFileSync(join(src, "report_latest.md"), brief);
    writeFileSync(join(src, "archives", "report_20261101_070000.md"), brief);
    writeFileSync(join(src, "weekly_wrap.md"), brief);
    writeFileSync(join(src, "weekly_wrap.json"), JSON.stringify({ week_end: "2026-11-01", markdown: brief }));
    const digest = {
      edition: "20261101-100",
      subject: "Tolu Bakare takes Ikeja Mills",
      preheader: "Also: CBN raises rates",
      cards: [{ headline: "Tolu Bakare takes Ikeja Mills" }, { headline: "CBN raises rates" }],
      psc: [{ text: "Tolu Bakare holds 60% of Ikeja Mills" }],
      psc_keys: ["tolu bakare|ikeja mills|https://punchng.com/0"],
    };
    writeFileSync(join(src, "digests", "20261101-100.json"), JSON.stringify(digest));
    writeFileSync(join(src, "email_digest.json"), JSON.stringify(digest));
    writeFileSync(join(src, "suppressed.json"), '[{"name":"Tolu Bakare","reason":"dispute upheld"}]');
    const run = () =>
      execFileSync(process.execPath, [script], { env: { ...process.env, COPY_DATA_SRC: src, COPY_DATA_DEST: dest }, stdio: "ignore" });
    run();

    const read = (path: string) => readFileSync(join(dest, path), "utf-8");
    for (const path of ["report_latest.md", "archives/report_20261101_070000.md", "weekly_wrap.md"]) {
      assert.equal(read(path), "# Brief\n- CBN raises rates\n", path);
    }
    assert.equal(JSON.parse(read("weekly_wrap.json")).markdown, "# Brief\n- CBN raises rates\n");
    for (const path of ["digests/20261101-100.json", "email_digest.json"]) {
      const out = JSON.parse(read(path));
      assert.doesNotMatch(read(path), /Bakare/i, path);
      assert.deepEqual(out.cards, [{ headline: "CBN raises rates" }], path);
      assert.equal(out.preheader, "Also: CBN raises rates", path);
    }

    // With nothing unpublished, every file is copied byte for byte.
    rmSync(join(src, "suppressed.json"));
    run();
    assert.equal(read("report_latest.md"), brief);
    assert.equal(read("digests/20261101-100.json"), JSON.stringify(digest));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
