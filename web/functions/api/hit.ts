/**
 * Cookieless reader counts.
 *
 * POST /api/hit  {"p": "/brief/", "s": "brief-20261107-11218"}
 *   One page view, sent by the site's hit script with navigator.sendBeacon.
 * GET  /api/hit?to=<url on this site>&s=<source>[&p=<path>]
 *   One click from an email, then a 302 to `to`.
 *
 * Only a daily count per page path and source is stored (table hits,
 * migrations/0006_hits.sql). Nothing about the reader is read or kept: no
 * IP address, user agent, cookie or identifier. The user agent is looked at
 * only to skip bots, and readers who send Do Not Track or Global Privacy
 * Control are not counted.
 */
import { json, type Ctx, type D1Like } from "../_lib/http.ts";
import { lagosDay } from "./send-brief.ts";

const BOT_RE = /bot|crawler|spider/i;
const SOURCE_RE = /^[a-z0-9-]{1,40}$/;

/** The page path without query or fragment, or null when it is not a usable path. */
export function cleanPath(value: unknown): string | null {
  const path = String(value ?? "").split(/[?#]/)[0];
  return path.startsWith("/") && path.length <= 200 ? path : null;
}

/** "" for no source, the source when it is short lowercase letters, digits and dashes, else null. */
export function cleanSource(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "";
  const source = String(value);
  return SOURCE_RE.test(source) ? source : null;
}

/** Bots are not readers, and a reader who asked not to be tracked is not counted. */
function shouldCount(request: Request): boolean {
  const h = request.headers;
  return !BOT_RE.test(h.get("User-Agent") || "") && h.get("Sec-GPC") !== "1" && h.get("DNT") !== "1";
}

async function count(db: D1Like, day: string, path: string, source: string): Promise<void> {
  await db
    .prepare("INSERT INTO hits (day, path, source, count) VALUES (?, ?, ?, 1) ON CONFLICT (day, path, source) DO UPDATE SET count = count + 1")
    .bind(day, path, source)
    .run();
}

export async function onRequestPost({ request, env }: Ctx, now = new Date()): Promise<Response> {
  // A beacon is a few dozen bytes of JSON, sent as text/plain so the browser
  // needs no preflight; parse it whatever the content type says.
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 1000) throw new Error("too long");
    body = JSON.parse(text);
    if (!body || typeof body !== "object") throw new Error("not an object");
  } catch {
    return json({ error: "Send JSON like {\"p\": \"/\"}." }, 400);
  }
  const path = cleanPath(body.p);
  const source = cleanSource(body.s);
  if (path === null || source === null) return json({ error: "Bad path or source." }, 400);
  if (!shouldCount(request)) return new Response(null, { status: 204 });
  if (!env.DB) return json({ error: "Database (DB) is not bound." }, 503);
  await count(env.DB, lagosDay(now), path, source);
  return new Response(null, { status: 204 });
}

export async function onRequestGet({ request, env }: Ctx, now = new Date()): Promise<Response> {
  const url = new URL(request.url);
  // Open-redirect protection: only this site's own pages, by exact origin.
  const own = new Set([url.origin]);
  if (env.SITE_URL) own.add(new URL(env.SITE_URL).origin);
  let to: URL;
  try {
    to = new URL(url.searchParams.get("to") || "");
  } catch {
    return json({ error: "Missing or bad 'to' address." }, 400);
  }
  if (!own.has(to.origin)) return json({ error: "Links may only go to this site." }, 400);

  const path = cleanPath(url.searchParams.get("p") || to.pathname);
  const source = cleanSource(url.searchParams.get("s"));
  // Counting is best effort: the reader always gets to the page.
  if (env.DB && path !== null && source !== null && shouldCount(request)) {
    try {
      await count(env.DB, lagosDay(now), path, source);
    } catch {
      /* the count is lost, the click is not */
    }
  }
  return new Response(null, { status: 302, headers: { Location: to.toString(), "Cache-Control": "no-store" } });
}

export function onRequest(): Response {
  return json({ error: "Use POST or GET." }, 405, { Allow: "POST, GET" });
}
