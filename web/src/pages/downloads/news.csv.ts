/** The stories on the news page (latest.json) as CSV. */
import * as data from "../../lib/data.ts";
import { newsCsv } from "../../lib/exports.ts";

export function GET() {
  return new Response(newsCsv(data.articles()), { headers: { "Content-Type": "text/csv; charset=utf-8" } });
}
