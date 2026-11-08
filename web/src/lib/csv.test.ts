import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { csvCell, toCsv } from "./csv.ts";

describe("csv", () => {
  test("plain values pass through", () => {
    assert.equal(csvCell("Dangote Cement Plc"), "Dangote Cement Plc");
    assert.equal(csvCell(42), "42");
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined), "");
  });

  test("commas, quotes and line breaks are quoted", () => {
    assert.equal(csvCell("Lagos, Nigeria"), '"Lagos, Nigeria"');
    assert.equal(csvCell('He said "no"'), '"He said ""no"""');
    assert.equal(csvCell("two\nlines"), '"two\nlines"');
  });

  test("cells a spreadsheet would run as a formula are neutralised", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      const cell = csvCell(`${lead}HYPERLINK("http://evil.test")`);
      // The leading apostrophe makes Excel and Sheets show the text, not run it.
      assert.ok(cell.replace(/^"/, "").startsWith(`'${lead}`), `${JSON.stringify(lead)} -> ${cell}`);
    }
    assert.equal(csvCell("=1+1"), "'=1+1");
    assert.equal(csvCell("a=1"), "a=1");
  });

  test("numbers stay numbers, even negative ones", () => {
    assert.equal(csvCell(-5), "-5");
  });

  test("a table has a header row and CRLF line endings", () => {
    assert.equal(toCsv(["Name", "Stake"], [["A, B", 10], ["=cmd", null]]), 'Name,Stake\r\n"A, B",10\r\n\'=cmd,\r\n');
  });
});
