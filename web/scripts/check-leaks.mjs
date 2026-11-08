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
  {
    // A named person on headline-only reporting, held for the owner's review.
    "Person Name": "Zedekiah Leakcheck-Headline", Company: "Sentinel Headline Holdings Plc",
    Percentage: "33%", "Nature of Control": "Ownership of shares", Source: "extracted",
    "Source URL": "https://example.com/leakcheck-headline", Date: runDate,
    Quarantined: false, Quality: ["unverified_person", "no_filing"], Confidence: "Headline only",
  },
  {
    // A sourced person row exported before the gate gave rows a tier: nothing
    // says it rests on more than a headline.
    "Person Name": "Zedekiah Leakcheck-Legacy", Company: "Sentinel Legacy Holdings Plc",
    Percentage: "12%", "Nature of Control": "Ownership of shares", Source: "extracted",
    "Source URL": "https://example.com/leakcheck-legacy", Date: runDate,
  },
  {
    // A company holder with a person as previous holder, on a headline alone:
    // the card would name the previous holder.
    "Person Name": "Sentinel Buyer Industries Ltd", Company: "Sentinel Target Mills Plc",
    "Previous Holder": "Zedekiah Leakcheck-Previous", "Change Type": "acquired",
    Percentage: "40%", "Nature of Control": "Ownership of shares", Source: "extracted",
    "Source URL": "https://example.com/leakcheck-previous", Date: runDate,
  },
];
// A sourced row the gate publishes: it must reach /changes/, which proves
// that page would show a withheld row too if it read the raw register.
const CONTROL = {
  "Person Name": "Zedekiah Leakcheck-Published", Company: "Sentinel Published Holdings Plc",
  Percentage: "12%", "Nature of Control": "Ownership of shares", Source: "extracted", Date: runDate,
  "Source URL": "https://example.com/leakcheck-control", Confidence: "Full article",
};
const registerPath = join(data, "significant_control.json");
const register = JSON.parse(readFileSync(registerPath, "utf-8"));

// A fully published holder the owner has unpublished (suppressed.json):
// committed data must stop rendering on the next build, before any run.
const HIDDEN = { person: "Zedekiah Leakcheck-Suppressed", company: "Sentinel Suppressed Mills Plc" };
const hiddenRow = {
  "Person Name": HIDDEN.person, Company: HIDDEN.company, Percentage: "55%", "Nature of Control": "Ownership of shares",
  Source: "extracted", "Source URL": "https://punchng.com/sentinel", "Source Title": "Sentinel takes control",
  Date: runDate, Kind: "stake", Public: true, Quarantined: false,
};
// The same person as the register might spell them: a middle initial and a
// neutral title, so only the canonical key ties the row to the hidden name.
const variantRow = {
  ...hiddenRow, "Person Name": "Zedekiah Q. Leakcheck-Suppressed", Company: "Sentinel Variant Mills Ltd",
  "Source URL": "https://punchng.com/variant", "Source Title": "Mills changes hands",
};
writeFileSync(registerPath, JSON.stringify([...register, ...SENTINELS, CONTROL, hiddenRow, variantRow], null, 2));
const addRows = (file, rows) => {
  const path = join(data, file);
  writeFileSync(path, JSON.stringify([...JSON.parse(readFileSync(path, "utf-8")), ...rows], null, 2));
};
// Dated on the last run, so every /changes/ section (companies and people
// first seen, board moves, contracts) would list the unpublished rows if it
// read the raw export. Each published control beside them must be listed,
// which proves the section was there to check.
const CONTROLS = {
  company: "Sentinel Control Foods Plc", person: "Zedekiah Leakcheck-Appointed", contractor: "Sentinel Control Works Ltd",
  story: "Sentinel Control Foods Plc opens a mill", psc: "Sentinel Control Foods Plc holds 20% of Sentinel Control Works Ltd",
  alert: "Sentinel control alert: Federal Ministry of Works audits road fund",
};
addRows("companies.json", [
  { Company: HIDDEN.company, "Mention Count": 40, "First Seen": runDate, "Last Seen": runDate },
  { Company: CONTROLS.company, "Mention Count": 1, "First Seen": runDate, "Last Seen": runDate },
]);
addRows("people.json", [
  { Name: HIDDEN.person, Position: "Chairman", Organization: HIDDEN.company, Event: "appointment", Date: runDate, "First Seen": runDate },
  { Name: CONTROLS.person, Position: "Chairman", Organization: CONTROLS.company, Event: "appointment", Date: runDate, "First Seen": runDate },
]);
addRows("procurement.json", [
  { Agency: "Federal Ministry of Works", Contractor: HIDDEN.company, Project: "Road", Date: runDate },
  { Agency: "Federal Ministry of Works", Contractor: CONTROLS.contractor, Project: "Bridge", Date: runDate },
]);
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
// A sent edition of its own, so the archive's edition pages are checked
// whichever editions the real data holds.
const sentEdition = `${runDate.replace(/-/g, "")}-99999999`;
writeFileSync(join(data, "digests", `${sentEdition}.json`), JSON.stringify({
  ...JSON.parse(readFileSync(join(data, "email_digest.json"), "utf-8")), edition: sentEdition, through_id: 99999999, preview: false,
}, null, 2));
PLANTED.push(`digests/${sentEdition}.json`);
// A story card and an ownership line naming the unpublished holder, each
// beside a control that must reach the page.
const card = (n, headline, named) => ({
  n, theme: "Ownership & control", event_type: "Ownership", flags: [], alert: false, risk: "", headline,
  byline: "Punch", outlet: "Punch", what_happened: `${headline}.`, key_facts: [], timeline: [], headline_only: false,
  analysis: [], ownership_caveat: "", named, source: { outlet: "Punch", url: "https://punchng.com/sentinel" }, also_reported: [], also_more: 0,
});
const pscLine = (text) => ({ text, outlet: "Punch", date: runDate, url: "https://punchng.com/sentinel", confidence: "Full article" });
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
    edition.cards = [card(98, CONTROLS.story, [CONTROLS.company]), card(99, hiddenLine.slice(2), [HIDDEN.person, HIDDEN.company]), ...(edition.cards ?? [])];
    edition.psc = [pscLine(CONTROLS.psc), pscLine(`${HIDDEN.person} holds 55% of ${HIDDEN.company}`), ...(edition.psc ?? [])];
    writeFileSync(path, JSON.stringify(edition, null, 2));
  }
}
// High-risk alerts for the inbox on every page (and the alerts feed).
const alertsPath = join(data, "alerts.json");
const alertsFile = JSON.parse(readFileSync(alertsPath, "utf-8"));
const alert = (title, url) => ({ date: runDate, title, url, source: "The Punch", risk_score: 95, risk_level: "Critical" });
alertsFile.alerts = [
  alert(CONTROLS.alert, "https://punchng.com/control-alert"),
  { ...alert(hiddenLine.slice(2), "https://punchng.com/sentinel-alert"), entities: [HIDDEN.person, HIDDEN.company] },
  ...(alertsFile.alerts ?? []),
];
writeFileSync(alertsPath, JSON.stringify(alertsFile, null, 2));
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
  const RUN_REWRITES = new Set(["significant_control.json", "companies.json", "people.json", "procurement.json", "latest.json", "category_news.json", "alerts.json"]);
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
  const changes = readFileSync(join(out, "changes", "index.html"), "utf-8");
  // Each /changes/ section, the brief pages and the alerts inbox must show the
  // control planted beside each unpublished row, or the walk proved nothing there.
  const section = (html, id) => (html.split(`id="${id}"`)[1] ?? "").split(/<h2|<\/section>/)[0];
  for (const [id, name] of [["companies", CONTROLS.company], ["people", CONTROLS.person], ["moves", CONTROLS.person], ["contracts", CONTROLS.contractor]]) {
    if (!section(changes, id).includes(name)) leaks.push(`/changes/#${id}: the published control row is missing, so this check proves nothing there`);
  }
  const built = (path) => {
    try {
      return readFileSync(join(out, path), "utf-8");
    } catch {
      return "";
    }
  };
  const inbox = (built("index.html").split('id="aura-alerts"')[1] ?? "").split("</script>")[0];
  for (const [where, html, controls] of [
    ["/brief/email/", built("brief/email/index.html"), [CONTROLS.story, CONTROLS.psc]],
    ["/brief/morning/", built("brief/morning/index.html"), [`brief/morning/${sentEdition}/`]],
    [`/brief/morning/${sentEdition}/`, built(`brief/morning/${sentEdition}/index.html`), [CONTROLS.story, CONTROLS.psc]],
    ["the alerts inbox", inbox, [CONTROLS.alert]],
  ]) {
    for (const c of controls) if (!html.includes(c)) leaks.push(`${where}: the planted control "${c}" is missing, so this check proves nothing there`);
  }
  if (!changes.includes(CONTROL["Person Name"])) leaks.push("/changes/: the published control row is missing, so this check proves nothing there");

  if (leaks.length) {
    console.error("check-leaks: withheld or unpublished names reached the site:\n  " + leaks.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log(`check-leaks: OK, ${SENTINELS.length} withheld rows and an unpublished holder appear on no page.`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
