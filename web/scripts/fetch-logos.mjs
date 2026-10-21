// Fetches organisation logos into public/logos/<key>.png at deploy time.
//
// Best effort by design: each logo has a short timeout, a missing or tiny
// image is skipped, and the script never fails the build. The site shows a
// logo only when the file exists, so a fetch that fails just means a plain
// typographic card. Logos already present (from the deploy cache) are kept.
//
// Sources, in order: the organisation's own apple-touch-icon (usually a
// clean 180px mark), then Google's favicon service at 256px.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../public/logos");
mkdirSync(dir, { recursive: true });

// The registry lives in src/lib/logos.ts; read the keys and domains from it
// rather than keeping a second list.
const source = await import("node:fs").then((fs) => fs.readFileSync(resolve(here, "../src/lib/logos.ts"), "utf-8"));
const entries = [...source.matchAll(/\{ key: "([a-z0-9]+)", name: "[^"]*", domain: "([^"]+)"/g)].map((m) => ({ key: m[1], domain: m[2] }));

const MIN_SIZE = 96;

/** Width and height of a PNG, or null if the bytes are not a PNG. */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

async function get(url) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "user-agent": "AURA-logo-fetch/1.0" } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const size = pngSize(buf);
    return size && size.w >= MIN_SIZE && size.h >= MIN_SIZE ? buf : null;
  } catch {
    return null;
  }
}

let fetched = 0;
let kept = 0;
await Promise.all(entries.map(async ({ key, domain }) => {
  const out = resolve(dir, `${key}.png`);
  if (existsSync(out)) { kept++; return; }
  const buf =
    (await get(`https://${domain}/apple-touch-icon.png`)) ||
    (await get(`https://www.${domain}/apple-touch-icon.png`)) ||
    (await get(`https://www.google.com/s2/favicons?domain=${domain}&sz=256`));
  if (buf) { writeFileSync(out, buf); fetched++; }
}));
console.log(`fetch-logos: ${fetched} fetched, ${kept} cached, ${entries.length - fetched - kept} unavailable (typographic cards)`);
