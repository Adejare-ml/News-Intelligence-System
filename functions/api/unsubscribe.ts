/**
 * GET or POST /api/unsubscribe?token=...  One click, no login, no questions.
 * POST supports RFC 8058 one-click unsubscribe from mail clients.
 */
import { page, validToken, type Ctx } from "../_lib/http.ts";
import { subscriberStore } from "../_lib/subscribers.ts";

async function leave({ request, env }: Ctx): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (validToken(token) && env.DB) {
    await subscriberStore(env.DB).unsubscribe(token, new Date().toISOString());
  }
  // Same answer either way: never confirm whether a token or address exists.
  return page("You’re unsubscribed.", "You won’t receive the AURA Morning Brief any more. You can sign up again any time.");
}

export const onRequestGet = leave;
export const onRequestPost = leave;
