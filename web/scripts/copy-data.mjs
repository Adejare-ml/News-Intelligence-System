// Publishes the pipeline's exports at /data/* (feed.xml, latest.json, ...)
// so their public URLs survive the move to the new site. The pipeline keeps
// writing to backend/app/static/data/; this copy is a build artefact.
// COPY_DATA_SRC / COPY_DATA_DEST override the folders, for tests.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hiddenNames, scrubDigest, withoutHiddenLines } from "../src/lib/suppressed.ts";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(process.env.COPY_DATA_SRC || resolve(here, "../../backend/app/static/data"));
const dest = resolve(process.env.COPY_DATA_DEST || resolve(here, "../public/data"));

// The names the owner unpublished (scripts/unpublish.py) are read at build
// time from the pipeline's folder. Serving the list itself would point
// readers straight at the people who asked to come off the site.
const NOT_PUBLISHED = new Set(["suppressed.json"]);

// Files the pipeline writes once and never rewrites: each brief edition,
// each sent email, the weekly wrap until the next week. A name unpublished
// after they were written is taken out as they are copied, as the site's
// own pages leave it out. (Every pipeline run rewrites the row exports,
// latest.json, significant_control.json and the rest, from scrubbed rows.)
// A rule: which files, by their path under src ("/"-separated), and how to
// rewrite one's text.
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const json = (edit) => (text, hidden) => {
  const before = JSON.parse(text);
  const after = edit(before, hidden);
  // Unchanged files keep their bytes.
  return JSON.stringify(after) === JSON.stringify(before) ? text : JSON.stringify(after, null, 2);
};
const SCRUB = [
  { files: /^(report_latest|weekly_wrap)\.md$|^archives\/[^/]+\.md$/, rewrite: withoutHiddenLines },
  {
    files: /^weekly_wrap\.json$/,
    rewrite: json((wrap, hidden) =>
      isObject(wrap) && typeof wrap.markdown === "string" ? { ...wrap, markdown: withoutHiddenLines(wrap.markdown, hidden) } : wrap,
    ),
  },
  { files: /^email_digest\.json$|^digests\/[^/]+\.json$/, rewrite: json((digest, hidden) => (isObject(digest) ? scrubDigest(digest, hidden) : digest)) },
];

/** The unpublished names; none when the list is missing or unreadable, as on the site. */
function readHidden() {
  try {
    return hiddenNames(JSON.parse(readFileSync(join(src, "suppressed.json"), "utf-8")));
  } catch {
    return [];
  }
}

if (!existsSync(src)) {
  console.error(`copy-data: ${src} not found`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true, filter: (path) => !NOT_PUBLISHED.has(basename(path)) });

const hidden = readHidden();
if (hidden.length) {
  let changed = 0;
  for (const rel of readdirSync(dest, { recursive: true })) {
    const path = String(rel).split(sep).join("/");
    const rule = SCRUB.find((r) => r.files.test(path));
    if (!rule) continue;
    const file = join(dest, path);
    try {
      const text = readFileSync(file, "utf-8");
      const out = rule.rewrite(text, hidden);
      if (out !== text) {
        writeFileSync(file, out);
        changed += 1;
      }
    } catch (err) {
      // A copy the list could not be applied to is not served at all.
      rmSync(file, { force: true });
      console.warn(`copy-data: left out ${path}, which could not be checked for unpublished names (${err.message})`);
    }
  }
  console.log(`copy-data: took ${hidden.length} unpublished name(s) out of ${changed} brief and digest file(s)`);
}
console.log(`copy-data: published ${src} -> public/data`);
