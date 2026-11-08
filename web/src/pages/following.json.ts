/**
 * /following.json: the stories and alerts the browser Follow panel and the
 * bell dot match followed companies against (scripts/follow.ts). Built from
 * data.articles() and data.alerts(), so a name the owner unpublished is gone
 * on the next build, as on every page; the raw /data/latest.json and
 * /data/alerts.json keep it until the next pipeline run. Same origin, so the
 * CSP's connect-src 'self' allows the fetch.
 */
import * as data from "../lib/data.ts";
import { followingFeed } from "../lib/follow.ts";

export function GET() {
  const body = followingFeed(data.articles(), data.alerts().alerts ?? []);
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json; charset=utf-8" } });
}
