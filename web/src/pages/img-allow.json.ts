/** The image proxy's allowlist: lead images of the currently published articles. */
import * as data from "../lib/data.ts";

export function GET() {
  const urls = [...new Set(data.articles().map((a) => String(a.Image || "")).filter((u) => /^https?:\/\//.test(u)))];
  return new Response(JSON.stringify(urls), { headers: { "Content-Type": "application/json" } });
}
