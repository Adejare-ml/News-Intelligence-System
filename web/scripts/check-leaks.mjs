// Leak check for the register's publishing contract.
//
// Builds the site against a copy of the real data with rows the
// validation gate must keep off every page (one with no source, one
// quarantined, one naming a person on a headline alone, a legacy person
// row with no tier, a company row naming a person as previous holder),
// then fails if any of their names appears anywhere in the output.
// This catches a component that reads the raw register instead of
// data.psc(), which is how the "No source on file" rows leaked onto the
// home and entity pages before.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const realData = resolve(web, "../backend/app/static/data");

const work = mkdtempSync(join(tmpdir(), "aura-leak-"));
const data = join(work, "data");
const out = join(work, "out");
cpSync(realData, data, { recursive: true });

const SENTINELS = [
  {
    "Person Name": "Zedekiah Leakcheck-Unsourced", Company: "Sentinel Unsourced Holdings Plc",
    Percentage: "61.5%", "Nature of Control": "Ownership of shares", Source: "", Date: "2026-10-20",
  },
  {
    "Person Name": "Zedekiah Leakcheck-Quarantined", Company: "Sentinel Quarantined Ltd",
    Percentage: "", "Nature of Control": "Significant influence or control", Source: "extracted",
    Date: "2026-10-20", Quarantined: true, Quality: ["implausible"],
  },
  {
    // A named person on headline-only reporting, held for the owner's review.
    "Person Name": "Zedekiah Leakcheck-Headline", Company: "Sentinel Headline Holdings Plc",
    Percentage: "33%", "Nature of Control": "Ownership of shares", Source: "extracted",
    "Source URL": "https://example.com/leakcheck-headline", Date: "2026-10-20",
    Quarantined: false, Quality: ["unverified_person", "no_filing"], Confidence: "Headline only",
  },
  {
    // A sourced person row exported before the gate gave rows a tier: nothing
    // says it rests on more than a headline.
    "Person Name": "Zedekiah Leakcheck-Legacy", Company: "Sentinel Legacy Holdings Plc",
    Percentage: "12%", "Nature of Control": "Ownership of shares", Source: "extracted",
    "Source URL": "https://example.com/leakcheck-legacy", Date: "2026-10-20",
  },
  {
    // A company holder with a person as previous holder, on a headline alone:
    // the card would name the previous holder.
    "Person Name": "Sentinel Buyer Industries Ltd", Company: "Sentinel Target Mills Plc",
    "Previous Holder": "Zedekiah Leakcheck-Previous", "Change Type": "acquired",
    Percentage: "40%", "Nature of Control": "Ownership of shares", Source: "extracted",
    "Source URL": "https://example.com/leakcheck-previous", Date: "2026-10-20",
  },
];
const registerPath = join(data, "significant_control.json");
const register = JSON.parse(readFileSync(registerPath, "utf-8"));
writeFileSync(registerPath, JSON.stringify([...register, ...SENTINELS], null, 2));

try {
  execFileSync("npx", ["astro", "build", "--outDir", out], {
    cwd: web,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, AURA_DATA_DIR: data },
  });

  const leaks = [];
  const needles = SENTINELS.flatMap((r) => [r["Person Name"], r.Company, r["Previous Holder"]].filter(Boolean));
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      // /data/* is the pipeline's raw export, copied as-is; not a rendered page.
      if (statSync(path).isDirectory()) {
        if (path !== join(out, "data")) walk(path);
        continue;
      }
      if (!/\.(html|json|xml|txt)$/.test(name)) continue;
      const text = readFileSync(path, "utf-8");
      for (const n of needles) if (text.includes(n)) leaks.push(`${path.slice(out.length)}: ${n}`);
    }
  };
  walk(out);

  if (leaks.length) {
    console.error("check-leaks: withheld register rows reached the site:\n  " + leaks.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log(`check-leaks: OK, ${SENTINELS.length} withheld rows appear on no page.`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
