// Build check for the Morning Brief archive (/brief/morning/).
//
// Run after scripts/build-sites.sh, against each built copy in out/. Fails if
// an edition subscribers were sent (or are about to be sent) has no page,
// since the email's "View in browser" link points there; if a public page
// still carries a {{...}} placeholder, which the sender fills with a
// reader's personal unsubscribe or preferences link; if an edition page can
// be indexed (they name people from news reports); or if the sitemap lists
// one.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { morningEditions } from "../src/lib/morning.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const dataDir = process.env.AURA_DATA_DIR ? resolve(process.env.AURA_DATA_DIR) : resolve(web, "../backend/app/static/data");

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};
const digestsDir = join(dataDir, "digests");
const archived = existsSync(digestsDir)
  ? readdirSync(digestsDir).filter((f) => f.endsWith(".json")).map((f) => readJson(join(digestsDir, f)))
  : [];
const editions = morningEditions(archived, readJson(join(dataDir, "email_digest.json")));

const problems = [];
const sites = readdirSync(join(web, "out")).filter((name) => existsSync(join(web, "out", name, "index.html")));
for (const site of sites) {
  const out = join(web, "out", site);
  const page = (path) => {
    const file = join(out, path, "index.html");
    if (!existsSync(file)) {
      problems.push(`${site}: /${path} was not built`);
      return "";
    }
    return readFileSync(file, "utf-8");
  };
  const pages = { "brief/morning/": page("brief/morning/") };
  for (const d of editions) pages[`brief/morning/${d.edition}/`] = page(`brief/morning/${d.edition}/`);
  for (const [path, html] of Object.entries(pages)) {
    if (html.includes("{{")) problems.push(`${site}: /${path} has a {{ placeholder`);
    if (path !== "brief/morning/" && html && !/<meta name="robots" content="noindex/.test(html)) {
      problems.push(`${site}: /${path} is missing noindex`);
    }
  }
  const sitemap = existsSync(join(out, "sitemap.xml")) ? readFileSync(join(out, "sitemap.xml"), "utf-8") : "";
  if (sitemap.includes("/brief/morning/")) problems.push(`${site}: the sitemap lists Morning Brief editions`);
}

if (!sites.length) problems.push("no built site in out/; run scripts/build-sites.sh first");
if (problems.length) {
  console.error("check-brief-archive:\n  " + problems.join("\n  "));
  process.exitCode = 1;
} else {
  console.log(`check-brief-archive: OK, ${editions.length} editions on ${sites.join(" and ")}.`);
}
