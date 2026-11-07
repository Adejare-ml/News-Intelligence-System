/**
 * Links from the Morning Brief back to the site carry ?src=brief-<edition>,
 * so the owner can see how many clicks each edition brought (see
 * functions/api/hit.ts). The tag names the edition only, never the reader:
 * every subscriber gets the same links.
 */
import { readJson } from "./data.ts";
import { listEditions } from "./archive.ts";
import { readDigest } from "./digest.ts";

/** The edition being emailed: the pipeline's email edition, else the newest archived brief. */
export function emailEdition(): string {
  return readDigest(readJson<unknown>("email_digest.json", null))?.edition ?? listEditions()[0]?.slug ?? "";
}

/** "brief-<edition>" as /api/hit accepts it (lowercase letters, digits, dashes; at most 40), or "" with no edition. */
export function briefSource(edition: string): string {
  if (!edition) return "";
  return `brief-${edition}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
}

/** `${site}/${path}`, tagged with the source when there is one. */
export function briefLink(site: string, path: string, source: string): string {
  return `${site}/${path}${source ? `?src=${source}` : ""}`;
}
