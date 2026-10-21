// Publishes the pipeline's exports at /data/* (feed.xml, latest.json, ...)
// so their public URLs survive the move to the new site. The pipeline keeps
// writing to backend/app/static/data/; this copy is a build artefact.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../backend/app/static/data");
const dest = resolve(here, "../public/data");

if (!existsSync(src)) {
  console.error(`copy-data: ${src} not found`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`copy-data: published ${src} -> public/data`);
