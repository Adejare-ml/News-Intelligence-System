/**
 * The Morning Brief's public archive: every edition subscribers were sent,
 * at /brief/morning/<edition>/, so an email can link to itself and readers
 * can share it.
 */
import { readDigest, type EmailDigest } from "./digest.ts";

/**
 * Editions to publish, newest first. `archived` is whatever sits in
 * digests/ (scripts/record_sent_edition.py writes one file per sent edition,
 * plus last_edition.json, which readDigest rejects). `current` is
 * email_digest.json: the edition about to be sent is built before it is
 * archived, and its page has to exist when the email goes out. A preview is
 * rebuilt between sends and never sent, so it gets no page.
 */
export function morningEditions(archived: unknown[], current: unknown): EmailDigest[] {
  const byId = new Map<string, EmailDigest>();
  for (const value of [...archived, current]) {
    const d = readDigest(value);
    if (d && !d.preview && !byId.has(d.edition)) byId.set(d.edition, d);
  }
  return [...byId.values()].sort((a, b) => b.through_id - a.through_id);
}

/** The archive index, or one edition's page. `site` has no trailing slash. */
export function morningUrl(site: string, edition?: string): string {
  return `${site}/brief/morning/${edition ? `${edition}/` : ""}`;
}

/** A preview has no page of its own, so its email links to the archive. */
export function viewInBrowserUrl(site: string, digest: EmailDigest): string {
  return morningUrl(site, digest.preview ? undefined : digest.edition);
}

export function whatsappUrl(title: string, url: string): string {
  return `https://wa.me/?text=${encodeURIComponent(`${title} ${url}`)}`;
}
