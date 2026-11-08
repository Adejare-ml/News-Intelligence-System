/**
 * GET /api/stats/traffic   Authorization: Bearer <BRIEF_SEND_SECRET>
 *
 * Reader counts for the owner over the last 30 Lagos days, from the hits
 * table (see ../hit.ts): page views per day, the 20 most-viewed pages, and
 * clicks from each Morning Brief edition beside how many it was sent to.
 * Counts only: the table holds nothing else.
 */
import { authorised, json, type Ctx } from "../../_lib/http.ts";
import { lagosDay } from "../send-brief.ts";

const DAYS = 30;
const TOP = 20;

export async function onRequestGet({ request, env }: Ctx, now = new Date()): Promise<Response> {
  if (!env.BRIEF_SEND_SECRET) return json({ error: "Stats need BRIEF_SEND_SECRET to be set." }, 503);
  if (!authorised(request, env)) return json({ error: "Not authorised." }, 401);
  if (!env.DB) return json({ error: "Database (DB) is not bound." }, 503);

  const since = lagosDay(new Date(now.getTime() - (DAYS - 1) * 86_400_000));
  const all = <T>(sql: string, ...args: unknown[]) =>
    env.DB!.prepare(sql).bind(...args).all<T>().then((r) => r.results);

  const days = await all("SELECT day, SUM(count) AS views FROM hits WHERE day >= ? GROUP BY day ORDER BY day", since);
  const topPaths = await all(
    "SELECT path, SUM(count) AS views FROM hits WHERE day >= ? GROUP BY path ORDER BY views DESC, path LIMIT ?",
    since,
    TOP,
  );
  // A brief link's source is "brief-<edition>"; sends logs the same edition id.
  const brief = await all(
    `SELECT substr(source, 7) AS edition, SUM(count) AS clicks,
            (SELECT SUM(sent) FROM sends WHERE sends.edition = substr(hits.source, 7)) AS sent
       FROM hits WHERE day >= ? AND source LIKE 'brief-%'
      GROUP BY source ORDER BY edition DESC`,
    since,
  );
  return json({ generated: now.toISOString(), since, days, top_paths: topPaths, brief });
}

export function onRequest(): Response {
  return json({ error: "Use GET." }, 405, { Allow: "GET" });
}
