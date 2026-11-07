// Leak check for the register's publishing contract.
//
// Builds the site against a copy of the real data with two rows the
// validation gate must keep off every page (one with no source, one
// quarantined), then fails if either name appears anywhere in the output.
// This catches a component that reads the raw register instead of
// data.psc(), which is how the "No source on file" rows leaked onto the
// home and entity pages before. It also adds a published holder named in
// suppressed.json, which must vanish the same way.
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
];
const registerPath = join(data, "significant_control.json");
const register = JSON.parse(readFileSync(registerPath, "utf-8"));

// A fully published holder the owner has unpublished (suppressed.json):
// committed data must stop rendering on the next build, before any run.
const HIDDEN = { person: "Zedekiah Leakcheck-Suppressed", company: "Sentinel Suppressed Mills Plc" };
const hiddenRow = {
  "Person Name": HIDDEN.person, Company: HIDDEN.company, Percentage: "55%", "Nature of Control": "Ownership of shares",
  Source: "extracted", "Source URL": "https://punchng.com/sentinel", "Source Title": "Sentinel takes control",
  Date: "2026-10-20", Kind: "stake", Public: true, Quarantined: false,
};
writeFileSync(registerPath, JSON.stringify([...register, ...SENTINELS, hiddenRow], null, 2));
const addRows = (file, rows) => {
  const path = join(data, file);
  writeFileSync(path, JSON.stringify([...JSON.parse(readFileSync(path, "utf-8")), ...rows], null, 2));
};
addRows("companies.json", [{ Company: HIDDEN.company, "Mention Count": 40, "Last Seen": "2026-10-20" }]);
addRows("people.json", [{ Name: HIDDEN.person, Position: "Chairman", Organization: HIDDEN.company, Date: "2026-10-20" }]);
addRows("procurement.json", [{ Agency: "Federal Ministry of Works", Contractor: HIDDEN.company, Project: "Road", Date: "2026-10-20" }]);
addRows("latest.json", [{
  ID: "999999", Time: "2026-10-20T07:00:00Z", Title: `${HIDDEN.person} takes control of ${HIDDEN.company}`,
  Source: "The Punch", URL: "https://punchng.com/sentinel", Category: "Corporate", "Risk Score": "80",
  Summary: "Sentinel story.", Entities: `${HIDDEN.person}|${HIDDEN.company}`,
}]);
writeFileSync(join(data, "suppressed.json"), JSON.stringify([{ name: HIDDEN.person }, { name: HIDDEN.company }]));

try {
  execFileSync("npx", ["astro", "build", "--outDir", out], {
    cwd: web,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, AURA_DATA_DIR: data },
  });

  const leaks = [];
  const needles = [...SENTINELS.flatMap((r) => [r["Person Name"], r.Company]), HIDDEN.person, HIDDEN.company];
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
    console.error("check-leaks: withheld or unpublished names reached the site:\n  " + leaks.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log(`check-leaks: OK, ${SENTINELS.length} withheld rows and an unpublished holder appear on no page.`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
