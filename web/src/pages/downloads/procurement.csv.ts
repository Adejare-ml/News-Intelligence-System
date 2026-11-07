/** Contracts in the news as CSV, in the order the register page lists them. */
import * as data from "../../lib/data.ts";
import { procurementCsv } from "../../lib/exports.ts";
import { sortContracts, toContract } from "../../lib/procurement.ts";

export function GET() {
  const contracts = sortContracts(data.procurement().map(toContract));
  return new Response(procurementCsv(contracts), { headers: { "Content-Type": "text/csv; charset=utf-8" } });
}
