import { test } from "node:test";
import assert from "node:assert/strict";
import { morningEditions, morningUrl, viewInBrowserUrl, whatsappUrl } from "./morning.ts";
import type { EmailDigest } from "./digest.ts";

const digest = (edition: string, through_id: number, extra: Partial<EmailDigest> = {}) =>
  ({ edition, through_id, cards: [], stats: {}, ...extra }) as unknown as EmailDigest;

test("archived editions are listed newest first; files without the digest shape are ignored", () => {
  const lastEdition = { edition: "20261106-11165", through_id: 11165, sent: 2 }; // last_edition.json
  const list = morningEditions(
    [digest("20261104-11000", 11000), lastEdition, null, "x", digest("20261106-11165", 11165), digest("20261105-11097", 11097)],
    null,
  );
  assert.deepEqual(list.map((d) => d.edition), ["20261106-11165", "20261105-11097", "20261104-11000"]);
});

test("the edition being sent is included before it is archived, and not twice once it is", () => {
  const archived = [digest("20261106-11165", 11165)];
  assert.deepEqual(morningEditions(archived, digest("20261107-11218", 11218)).map((d) => d.edition), ["20261107-11218", "20261106-11165"]);
  assert.deepEqual(morningEditions(archived, digest("20261106-11165", 11165)).map((d) => d.edition), ["20261106-11165"]);
});

test("a preview built between sends is never published", () => {
  const list = morningEditions([digest("20261106-11165", 11165)], digest("20261107-11218-preview", 11218, { preview: true }));
  assert.deepEqual(list.map((d) => d.edition), ["20261106-11165"]);
});

test("view in browser points at the edition's public page, or the archive for a preview", () => {
  const site = "https://auranews.pages.dev";
  assert.equal(morningUrl(site), "https://auranews.pages.dev/brief/morning/");
  assert.equal(viewInBrowserUrl(site, digest("20261107-11218", 11218)), "https://auranews.pages.dev/brief/morning/20261107-11218/");
  assert.equal(viewInBrowserUrl(site, digest("20261107-11218-preview", 11218, { preview: true })), "https://auranews.pages.dev/brief/morning/");
});

test("the WhatsApp link carries the title and the public URL, encoded", () => {
  assert.equal(
    whatsappUrl("AURA Morning Brief · Friday 6 November 2026", "https://auranews.pages.dev/brief/morning/20261106-11165/"),
    "https://wa.me/?text=AURA%20Morning%20Brief%20%C2%B7%20Friday%206%20November%202026%20https%3A%2F%2Fauranews.pages.dev%2Fbrief%2Fmorning%2F20261106-11165%2F",
  );
});
