/**
 * GET /img?u=<publisher image URL>
 *
 * Serves article lead images from AURA's own origin:
 *  - the visitor's browser never contacts the publisher (privacy, and the
 *    page's CSP can keep img-src to 'self');
 *  - publishers that block hotlinking still work;
 *  - images are cached at Cloudflare's edge for a week.
 *
 * Not an open proxy: only URLs listed in /img-allow.json (generated at
 * build time from the published articles) are fetched, only image
 * responses are passed through, and bodies over 6MB are refused.
 */
import type { Ctx } from "./_lib/http.ts";

const MAX_BYTES = 6 * 1024 * 1024;
const WEEK = 60 * 60 * 24 * 7;
let allow: { at: number; set: Set<string> } | null = null;

async function allowed(env: Ctx["env"], requestUrl: string, target: string): Promise<boolean> {
  if (!allow || Date.now() - allow.at > 10 * 60 * 1000) {
    try {
      const res = env.ASSETS
        ? await env.ASSETS.fetch(new URL("/img-allow.json", requestUrl).toString())
        : await fetch(new URL("/img-allow.json", requestUrl));
      const list = res.ok ? ((await res.json()) as string[]) : [];
      allow = { at: Date.now(), set: new Set(list) };
    } catch {
      allow = { at: Date.now(), set: new Set() };
    }
  }
  return allow.set.has(target);
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
}

export async function onRequestGet(ctx: Ctx): Promise<Response> {
  const { request, env } = ctx;
  const target = new URL(request.url).searchParams.get("u") || "";
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return notFound();
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return notFound();

  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  const hit = cache ? await cache.match(cacheKey) : undefined;
  if (hit) return hit;

  if (!(await allowed(env, request.url, target))) return notFound();

  let upstream: Response;
  try {
    upstream = await fetch(parsed.toString(), {
      headers: { "User-Agent": "AURA-NewsIntel/1.0 (+https://auranews.pages.dev)", Accept: "image/avif,image/webp,image/*" },
      redirect: "follow",
      referrerPolicy: "no-referrer",
    } as RequestInit);
  } catch {
    return notFound();
  }
  const type = upstream.headers.get("Content-Type") || "";
  const length = Number(upstream.headers.get("Content-Length") || 0);
  if (!upstream.ok || !type.startsWith("image/") || type.includes("svg") || length > MAX_BYTES) return notFound();

  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return notFound();

  const res = new Response(body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": `public, max-age=${WEEK}, immutable`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
  if (cache) ctx.waitUntil?.(cache.put(cacheKey, res.clone()));
  return res;
}
