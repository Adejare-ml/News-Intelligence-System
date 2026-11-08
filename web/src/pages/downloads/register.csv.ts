/** The published register as CSV: data.psc() is the gate, and registerCsv filters again. */
import * as data from "../../lib/data.ts";
import { registerCsv } from "../../lib/exports.ts";

export function GET() {
  return new Response(registerCsv(data.psc()), { headers: { "Content-Type": "text/csv; charset=utf-8" } });
}
