/** GET /api/confirm?token=...  Double opt-in: marks a pending address confirmed. */
import { escapeHtml, page, validToken, type Ctx } from "../_lib/http.ts";
import { describePrefs } from "../_lib/categories.ts";
import { subscriberStore } from "../_lib/subscribers.ts";

export async function onRequestGet({ request, env }: Ctx): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!validToken(token) || !env.DB) {
    return page("Link not recognised", "This confirmation link is invalid or has expired.", 400);
  }
  const store = subscriberStore(env.DB);
  const row = await store.byToken(token);
  if (!row) return page("Link not recognised", "This confirmation link is invalid or has expired.", 404);
  await store.confirm(token, new Date().toISOString());
  const when = row.frequency === "weekly" ? "every Monday at 08:00 Lagos time" : "at 08:00 Lagos time";
  return page(
    "You’re in.",
    `The AURA Morning Brief arrives ${when}: ${describePrefs(row)}. Every email has a one-click unsubscribe link.`,
    200,
    `<p><a href="/api/preferences?token=${escapeHtml(token)}">Change what you get</a></p>`,
  );
}
