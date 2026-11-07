// Leak check for the register's publishing contract.
//
// Builds the site against a copy of the real data with two rows the
// validation gate must keep off every page (one with no source, one
// quarantined), then fails if either name appears anywhere in the output.
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

// Date the sentinels on the last run, so they fall inside the week that
// /changes/ lists and that page is tested too.
const history = JSON.parse(readFileSync(join(data, "history.json"), "utf-8"));
const runDate = String(history.generated || new Date().toISOString()).slice(0, 10);

const SENTINELS = [
  {
    "Person Name": "Zedekiah Leakcheck-Unsourced", Company: "Sentinel Unsourced Holdings Plc",
    Percentage: "61.5%", "Nature of Control": "Ownership of shares", Source: "", Date: runDate,
  },
  {
    "Person Name": "Zedekiah Leakcheck-Quarantined", Company: "Sentinel Quarantined Ltd",
    Percentage: "", "Nature of Control": "Significant influence or control", Source: "extracted",
    Date: runDate, Quarantined: true, Quality: ["implausible"],
  },
];
// A sourced row the gate publishes: it must reach /changes/, which proves
// that page would show a withheld row too if it read the raw register.
const CONTROL = {
  "Person Name": "Zedekiah Leakcheck-Published", Company: "Sentinel Published Holdings Plc",
  Percentage: "12%", "Nature of Control": "Ownership of shares", Source: "extracted", Date: runDate,
  "Source URL": "https://example.com/leakcheck-control",
};
const registerPath = join(data, "significant_control.json");
const register = JSON.parse(readFileSync(registerPath, "utf-8"));
writeFileSync(registerPath, JSON.stringify([...register, ...SENTINELS, CONTROL], null, 2));

try {
  execFileSync("npx", ["astro", "build", "--outDir", out], {
    cwd: web,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, AURA_DATA_DIR: data },
  });

  const leaks = [];
  const needles = SENTINELS.flatMap((r) => [r["Person Name"], r.Company]);
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
  const changes = readFileSync(join(out, "changes", "index.html"), "utf-8");
  if (!changes.includes(CONTROL["Person Name"])) leaks.push("/changes/: the published control row is missing, so this check proves nothing there");

  if (leaks.length) {
    console.error("check-leaks: withheld register rows reached the site:\n  " + leaks.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log(`check-leaks: OK, ${SENTINELS.length} withheld rows appear on no page.`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
