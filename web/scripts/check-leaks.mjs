// Leak check for the register's publishing contract.
//
// Builds the site against a copy of the real data with rows the
// validation gate must keep off every page (one with no source, one
// quarantined, one naming a person on a headline alone, a legacy person
// row with no tier, a company row naming a person as previous holder),
// then fails if any of their names appears anywhere in the output.
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

// A fully published holder the owner has unpublished (suppressed.json):
// committed data must stop rendering on the next build, before any run.
const HIDDEN = { person: "Zedekiah Leakcheck-Suppressed", company: "Sentinel Suppressed Mills Plc" };
const hiddenRow = {
  "Person Name": HIDDEN.person, Company: HIDDEN.company, Percentage: "55%", "Nature of Control": "Ownership of shares",
  Source: "extracted", "Source URL": "https://punchng.com/sentinel", "Source Title": "Sentinel takes control",
  Date: "2026-10-20", Kind: "stake", Public: true, Quarantined: false,
};
// The same person as the register might spell them: a middle initial and a
// neutral title, so only the canonical key ties the row to the hidden name.
const variantRow = {
  ...hiddenRow, "Person Name": "Zedekiah Q. Leakcheck-Suppressed", Company: "Sentinel Variant Mills Ltd",
  "Source URL": "https://punchng.com/variant", "Source Title": "Mills changes hands",
};
writeFileSync(registerPath, JSON.stringify([...register, ...SENTINELS, hiddenRow, variantRow], null, 2));
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
// Category headlines feed /news/<category>/ and the emailed section pages.
const categoryPath = join(data, "category_news.json");
const categories = JSON.parse(readFileSync(categoryPath, "utf-8"));
categories.sections.politics.nigeria.unshift(
  { title: `${HIDDEN.person} speaks on 2027`, url: "https://punchng.com/speaks", source: "The Punch", published: "" },
  { title: "Sentinel Suppressed Mills posts results", url: "https://punchng.com/results", source: "The Punch", published: "" },
);
writeFileSync(categoryPath, JSON.stringify(categories, null, 2));
// Briefs and digests written before the name was unpublished. No pipeline
// run rewrites them, so their copy at /data/ is scrubbed as it is made
// (scripts/copy-data.mjs), as the pages built from them are.
const hiddenLine = `- ${HIDDEN.person} takes control of ${HIDDEN.company}`;
const newest = (dir, test) => readdirSync(join(data, dir)).filter(test).sort().pop();
const PLANTED = ["report_latest.md", "weekly_wrap.md", "weekly_wrap.json", "email_digest.json"];
const archive = newest("archives", (n) => n.endsWith(".md"));
const digest = newest("digests", (n) => /^\d.*\.json$/.test(n));
if (archive) PLANTED.push(`archives/${archive}`);
if (digest) PLANTED.push(`digests/${digest}`);
for (const file of PLANTED) {
  const path = join(data, file);
  const text = readFileSync(path, "utf-8");
  if (file.endsWith(".md")) {
    writeFileSync(path, `${text.trimEnd()}\n${hiddenLine}\n`);
  } else if (file === "weekly_wrap.json") {
    const wrap = JSON.parse(text);
    writeFileSync(path, JSON.stringify({ ...wrap, markdown: `${String(wrap.markdown ?? "").trimEnd()}\n${hiddenLine}\n` }, null, 2));
  } else {
    const edition = JSON.parse(text);
    edition.subject = `${HIDDEN.person} takes control`;
    edition.psc_keys = [...(edition.psc_keys ?? []), `${HIDDEN.person.toLowerCase()}|${HIDDEN.company.toLowerCase()}|https://punchng.com/sentinel`];
    writeFileSync(path, JSON.stringify(edition, null, 2));
  }
}
writeFileSync(join(data, "suppressed.json"), JSON.stringify([{ name: HIDDEN.person }, { name: HIDDEN.company }]));

try {
  execFileSync("npx", ["astro", "build", "--outDir", out], {
    cwd: web,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, AURA_DATA_DIR: data },
  });

  const leaks = [];
  // Cores of the hidden names, so the variant spellings count as leaks too.
  const unpublished = ["Leakcheck-Suppressed", "Sentinel Suppressed Mills", "Sentinel Variant Mills"];
  const needles = [...SENTINELS.flatMap((r) => [r["Person Name"], r.Company, r["Previous Holder"]].filter(Boolean)), ...unpublished];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      // /data/* is the pipeline's raw export, not a rendered page: checked below.
      if (statSync(path).isDirectory()) {
        if (path !== join(out, "data")) walk(path);
        continue;
      }
      if (!/\.(html|json|xml|txt)$/.test(name)) continue;
      const text = readFileSync(path, "utf-8");
      for (const n of needles) if (text.includes(n)) leaks.push(`${path.slice(out.length)}: ${n}`);
    }
  };
  // /data/* as a build publishes it: copy-data run on this data. The raw
  // register keeps the gate's withheld rows (the pipeline gates it), but no
  // copied file may name an unpublished entity, except the row exports
  // planted above, which every pipeline run rewrites from scrubbed rows
  // (tests/test_suppression.py).
  const outData = join(out, "data");
  rmSync(outData, { recursive: true, force: true });
  execFileSync(process.execPath, [join(here, "copy-data.mjs")], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, COPY_DATA_SRC: data, COPY_DATA_DEST: outData },
  });
  const RUN_REWRITES = new Set(["significant_control.json", "companies.json", "people.json", "procurement.json", "latest.json", "category_news.json"]);
  const walkData = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const file = path.slice(outData.length + 1).split("\\").join("/");
      if (statSync(path).isDirectory()) walkData(path);
      else if (!RUN_REWRITES.has(file)) {
        const text = readFileSync(path, "utf-8");
        for (const n of unpublished) if (text.includes(n)) leaks.push(`/data/${file}: ${n}`);
      }
    }
  };
  walkData(outData);
  for (const file of PLANTED) {
    try {
      statSync(join(outData, file));
    } catch {
      leaks.push(`/data/${file}: missing from the copy, so this check proves nothing there`);
    }
  }
  // Someone named here who asks for a correction must reach the private
  // dispute form, never a pre-filled public GitHub issue.
  const correctionPages = ["register/index.html", "how-it-works/index.html",
    ...readdirSync(join(out, "entity")).map((n) => `entity/${n}/index.html`)];
  for (const page of correctionPages) {
    let html = "";
    try {
      html = readFileSync(join(out, page), "utf-8");
    } catch {
      continue;
    }
    if (html.includes("github.com/Adejare-ml/News-Intelligence-System/issues/new")) {
      leaks.push(`/${page}: asks for corrections through a public GitHub issue, not /dispute/`);
    }
  }
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
