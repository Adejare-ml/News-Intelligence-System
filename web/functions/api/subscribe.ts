/**
 * POST /api/subscribe  { email, categories, region, frequency, company_site }
 *
 * Stores a pending subscriber in D1 (binding DB) with the kinds of news they
 * chose. If email sending is configured, sends a double opt-in confirmation;
 * otherwise the address waits as pending until sending is switched on.
 *
 * Idempotent, and never reveals whether an address is already on the list.
 * A confirmed reader's choices are never changed from here (anyone can type
 * anyone's address); they change them from the link in every email.
 */
import { json, newToken, readBody, validEmail, type Ctx } from "../_lib/http.ts";
import { confirmationMail, send, sendingEnabled } from "../_lib/mailer.ts";
import { parsePrefs } from "../_lib/categories.ts";
import { subscriberStore } from "../_lib/subscribers.ts";

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  const body = await readBody(request);
  if (!body) return json({ error: "Could not read the form." }, 400);

  // Honeypot: a filled hidden field means a bot. Answer as if it worked.
  if (String(body.company_site ?? "").trim()) return json({ ok: true });

  const email = validEmail(body.email);
  if (!email) return json({ error: "That email address doesn’t look right." }, 400);

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
  } else if (existing.status !== "confirmed") {
    await store.reopen(email, prefs);
  }

  if (existing?.status !== "confirmed" && token && sendingEnabled(env)) {
    const site = env.SITE_URL || new URL(request.url).origin;
    await send(env, confirmationMail(site, email, token, prefs));
    return json({ ok: true, message: "You’re on the list. Check your inbox to confirm." });
  }
  return json({ ok: true, message: "You’re on the list. The first brief goes out as soon as sending opens." });
}

export function onRequest(): Response {
  return json({ error: "Use POST." }, 405, { Allow: "POST" });
}
