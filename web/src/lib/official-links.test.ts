import { test } from "node:test";
import assert from "node:assert/strict";
import { officialLinks } from "./official-links.ts";

test("points to the four official registers, in a fixed order", () => {
  const links = officialLinks("Harmattan Logistics Limited");
  assert.deepEqual(
    links.map((l) => [l.key, l.href]),
    [
      ["cac", "https://search.cac.gov.ng/home"],
      ["nocopo", "https://nocopo.bpp.gov.ng/"],
      ["sec", "https://sec.gov.ng/"],
      ["ngx", "https://ngxgroup.com/exchange/data/company-profiles/"],
    ],
  );
  assert.ok(links.every((l) => !l.emphasis));
});

test("each link says what to look for, since none of the sites takes a search in the URL", () => {
  const [cac] = officialLinks("Harmattan Logistics Limited");
  assert.equal(cac.label, "CAC company search");
  assert.match(cac.note, /Harmattan Logistics Limited/);
});

test("a public company puts the exchange first and marks it", () => {
  for (const name of ["Dangote Cement Plc", "Zenith Bank PLC", "MTN Nigeria Communications plc."]) {
    const links = officialLinks(name);
    assert.equal(links[0].key, "ngx", name);
    assert.equal(links[0].emphasis, true, name);
    assert.equal(links.filter((l) => l.emphasis).length, 1, name);
  }
});

test("plc inside another word is not a public company", () => {
  assert.equal(officialLinks("Plcon Ventures Limited")[0].key, "cac");
});

test("no name, no links", () => {
  assert.deepEqual(officialLinks("  "), []);
});
