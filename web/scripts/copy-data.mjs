// Publishes the pipeline's exports at /data/* (feed.xml, latest.json, ...)
// so their public URLs survive the move to the new site. The pipeline keeps
// writing to backend/app/static/data/; this copy is a build artefact.
// COPY_DATA_SRC / COPY_DATA_DEST override the folders, for tests.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(process.env.COPY_DATA_SRC || resolve(here, "../../backend/app/static/data"));
const dest = resolve(process.env.COPY_DATA_DEST || resolve(here, "../public/data"));

// The names the owner unpublished (scripts/unpublish.py) are read at build
// time from the pipeline's folder. Serving the list itself would point
// readers straight at the people who asked to come off the site.
const NOT_PUBLISHED = new Set(["suppressed.json"]);

if (!existsSync(src)) {
  console.error(`copy-data: ${src} not found`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true, filter: (path) => !NOT_PUBLISHED.has(basename(path)) });
console.log(`copy-data: published ${src} -> public/data`);
