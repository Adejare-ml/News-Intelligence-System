/**
 * POST /api/subscribe  { email, categories, region, frequency, company_site }
 *
 * Stores a pending subscriber in D1 (binding DB) with the kinds of news they
 * chose. If email sending is configured, sends a double opt-in confirmation;
 * otherwise the address waits as pending until sending is switched on.
 *
 * Idempotent, and the response never reveals whether an address is already
 * on the list: everyone gets the same answer. Only the address's owner learns
 * more, by email. Nobody's saved choices are changed from here (anyone can
 * type anyone's address): a pending sign-up keeps what its owner chose, and a
 * confirmed reader gets an email with their own "change topics" link.
 */
import { json, newToken, readBody, validEmail, type Ctx } from "../_lib/http.ts";
import { alreadySubscribedMail, confirmationMail, send, sendingEnabled } from "../_lib/mailer.ts";
import { parsePrefs } from "../_lib/categories.ts";
import { subscriberStore } from "../_lib/subscribers.ts";

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  const body = await readBody(request);
  if (!body) return json({ error: "Could not read the form." }, 400);

  // Honeypot: a filled hidden field means a bot. Answer as if it worked.
  if (String(body.company_site ?? "").trim()) return json({ ok: true });

  const email = validEmail(body.email);
  if (!email) return json({ error: "That email address doesn’t look right." }, 400);

  // The sign-up form marks itself with choices=1. Such a post with no boxes
  // ticked is a mistake, not an old client that should default to Business.
  if (String(body.choices ?? "") === "1" && body.categories === undefined && body.category === undefined) body.categories = "none";
  const parsed = parsePrefs(body);
  if ("error" in parsed) return json({ error: parsed.error }, 400);
  const { prefs } = parsed;

  if (!env.DB) {
    return json({ error: "Sign-ups open very soon. The brief is already live on the site." }, 503);
  }

  const store = subscriberStore(env.DB);
  const existing = await store.byEmail(email);
  let token = existing?.token;
  if (!existing) {
    token = newToken();
    await store.create(email, token, prefs, new Date().toISOString());
  } else if (existing.status === "unsubscribed") {
    await store.reopen(email, prefs);
  }

  if (!sendingEnabled(env) || !token) {
    return json({ ok: true, message: "You’re on the list. The first brief goes out as soon as sending opens." });
  }
  const site = env.SITE_URL || new URL(request.url).origin;
  if (existing?.status === "confirmed") {
    await send(env, alreadySubscribedMail(site, email, token, existing, existing.paused));
  } else {
    // A pending row confirms what its owner first chose.
    await send(env, confirmationMail(site, email, token, existing?.status === "pending" ? existing : prefs));
  }
  return json({ ok: true, message: "Check your inbox: we’ve sent you an email about your subscription." });
}

export function onRequest(): Response {
  return json({ error: "Use POST." }, 405, { Allow: "POST" });
}
