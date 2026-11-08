/**
 * GET  /api/unsubscribe?token=...  A page with one "Unsubscribe" button.
 * POST /api/unsubscribe?token=...  Unsubscribes. No login, no questions.
 *
 * Opening the link changes nothing, so a mail scanner fetching it cannot
 * unsubscribe anyone. The POST also serves RFC 8058 one-click unsubscribe:
 * mail clients post "List-Unsubscribe=One-Click" here, and the body is not
 * needed because the token is in the URL.
 */
import { escapeHtml, page, validToken, type Ctx } from "../_lib/http.ts";
import { subscriberStore } from "../_lib/subscribers.ts";
import { followStore } from "../_lib/follows.ts";

const tokenOf = (request: Request) => new URL(request.url).searchParams.get("token") || "";

export function onRequestGet({ request }: Ctx): Response {
  // No lookup: the same page for every token, so it never confirms whether one exists.
  return page(
    "Unsubscribe?",
    "Press the button to stop the AURA Morning Brief. You can sign up again any time.",
    200,
    `<form method="post" action="/api/unsubscribe?token=${escapeHtml(tokenOf(request))}"><button type="submit">Unsubscribe</button></form>`,
  );
}

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  const token = tokenOf(request);
  if (validToken(token) && env.DB) {
    await subscriberStore(env.DB).unsubscribe(token, new Date().toISOString());
    // Followed companies are stored with the subscription, so they go with it
    // (and do not reappear if the address signs up again). Before migration
    // 0007 there is no follows table; unsubscribing must still work.
    await followStore(env.DB).clear(token).catch(() => {});
  }
  // Same answer either way: never confirm whether a token or address exists.
  return page("You’re unsubscribed.", "You won’t receive the AURA Morning Brief any more. You can sign up again any time.");
}
