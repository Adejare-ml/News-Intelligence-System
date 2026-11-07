/**
 * The tables behind /downloads/*.csv, built from the same exports as the pages.
 */
import { toCsv } from "./csv.ts";
import { publicRecords, type PscRecord } from "./psc.ts";
import { cleanTitle, parseTime, type Article } from "./stories.ts";
import type { Contract } from "./procurement.ts";

const text = (v: unknown) => String(v ?? "").trim();

/**
 * One line per register row. Filters through publicRecords itself, so a
 * caller that hands it the raw register still cannot publish a row the
 * validation gate withholds.
 */
export function registerCsv(records: PscRecord[]): string {
  return toCsv(
    ["Person", "Company", "Stake", "Nature of control", "Board role", "Change", "Reported", "Source title", "Publisher", "Source URL"],
    publicRecords(records).map((r) => [
      text(r["Person Name"]), text(r.Company), text(r.Percentage), text(r["Nature of Control"]), text(r["Board Role"]),
      text(r["Change Type"]), text(r.Date).slice(0, 10), text(r["Source Title"]), text(r.Publisher), text(r["Source URL"]),
    ]),
  );
}

export function procurementCsv(contracts: Contract[]): string {
  return toCsv(
    ["Project", "Agency", "Contractor", "Amount", "Currency", "Amount (as reported)", "Publisher", "Date"],
    contracts.map((c) => [c.project, c.agency, c.contractor, c.amount, c.currency, c.amountLabel, c.source, c.date]),
  );
}

// latest.json mixes ISO and RSS dates; one ISO format lets a spreadsheet sort the column. Unreadable values pass through as written.
const isoTime = (v: unknown) => parseTime(v)?.toISOString().replace(/\.\d{3}Z$/, "Z") ?? text(v);

export function newsCsv(articles: Article[]): string {
  return toCsv(
    ["Published", "Headline", "Publisher", "URL", "Category", "Risk score", "Risk level", "Entities", "Summary"],
    articles.map((a) => [
      isoTime(a.Time), cleanTitle(text(a.Title), text(a.Source)).title, text(a.Source), text(a.URL), text(a.Category),
      a["Risk Score"] ?? "", text(a["Risk Level"]),
      text(a.Entities).split("|").map((e) => e.trim()).filter(Boolean).join("; "), text(a.Summary),
    ]),
  );
}
