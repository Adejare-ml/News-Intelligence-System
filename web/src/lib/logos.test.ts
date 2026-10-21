import { test } from "node:test";
import assert from "node:assert/strict";
import { matchOrganisation } from "./logos.ts";

test("names the organisation a headline is about", () => {
  assert.equal(matchOrganisation(["EFCC, Emefiele differ over evidence in alleged fraudulent $6.23m CBN withdrawal"])?.key, "efcc");
  assert.equal(matchOrganisation(["FAAN begins earning MMA2 revenue as dispute ends"])?.key, "faan");
  assert.equal(matchOrganisation(["International Finance Corporation owns 6.5% of Quickmart"])?.key, "ifc");
});

test("abbreviations only match as whole, upper-case words", () => {
  assert.equal(matchOrganisation(["Customer success in fincc and ncc lower case"]), null);
  assert.equal(matchOrganisation(["Sunbeth buys stake"]), null);
});

test("falls back to the entities when the headline names none", () => {
  assert.equal(matchOrganisation(["Court jails eight", "Zenith Bank | Lagos"])?.key, "zenith");
});
