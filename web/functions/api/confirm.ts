/**
 * GET  /api/confirm?token=...  A page with one "Confirm" button.
 * POST /api/confirm?token=...  Double opt-in: marks a pending address confirmed.
 *
 * Opening the link changes nothing: mail scanners and link previews fetch
 * every link in an email, and must not confirm a subscription the owner
 * never asked for. Only the button press (a POST) does.
 */
import { escapeHtml, page, validToken, type Ctx } from "../_lib/http.ts";
import { describePrefs } from "../_lib/categories.ts";
import { subscriberStore, type Subscriber } from "../_lib/subscribers.ts";

async function load({ request, env }: Ctx): Promise<{ token: string; row: Subscriber } | Response> {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!validToken(token) || !env.DB) {
    return page("Link not recognised", "This confirmation link is invalid or has expired.", 400);
  }
  const row = await subscriberStore(env.DB).byToken(token);
  if (!row) return page("Link not recognised", "This confirmation link is invalid or has expired.", 404);
  return { token, row };
}

export async function onRequestGet(ctx: Ctx): Promise<Response> {
  const found = await load(ctx);
  if (found instanceof Response) return found;
  const { token, row } = found;
  return page(
    "Confirm your subscription",
    `One more step: press the button to start the AURA Morning Brief (${describePrefs(row)}).`,
    200,
    `<form method="post" action="/api/confirm?token=${escapeHtml(token)}"><button type="submit">Confirm my subscription</button></form>`,
  );
}

export async function onRequestPost(ctx: Ctx): Promise<Response> {
  const found = await load(ctx);
  if (found instanceof Response) return found;
  const { token, row } = found;
  await subscriberStore(ctx.env.DB!).confirm(token, new Date().toISOString());
  const when = row.frequency === "weekly" ? "every Monday at 08:00 Lagos time" : "at 08:00 Lagos time";
  return page(
    "You’re in.",
    `The AURA Morning Brief arrives ${when}: ${describePrefs(row)}. Every email has a one-click unsubscribe link.`,
    200,
    `<p><a href="/api/preferences?token=${escapeHtml(token)}">Change what you get</a></p>`,
  );
}
