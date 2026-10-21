/**
 * POST /api/subscribe  { email, company_site }
 *
 * Stores a pending subscriber in D1 (binding DB). If email sending is
 * configured, sends a double opt-in confirmation; otherwise the address
 * waits as pending until sending is switched on. Idempotent: subscribing
 * twice never reveals whether an address is already on the list.
 */
import { json, newToken, validEmail, type Ctx } from "../_lib/http.ts";
import { confirmationMail, send, sendingEnabled } from "../_lib/mailer.ts";

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const type = request.headers.get("Content-Type") || "";
    body = type.includes("application/json")
      ? await request.json()
      : Object.fromEntries((await request.formData()).entries());
  } catch {
    return json({ error: "Could not read the form." }, 400);
  }

  // Honeypot: a filled hidden field means a bot. Answer as if it worked.
  if (String(body.company_site ?? "").trim()) return json({ ok: true });

  const email = validEmail(body.email);
  if (!email) return json({ error: "That email address doesn’t look right." }, 400);

  if (!env.DB) {
    return json({ error: "Sign-ups open very soon. The brief is already live on the site." }, 503);
  }

  const now = new Date().toISOString();
  const existing = await env.DB.prepare("SELECT token, status FROM subscribers WHERE email = ?")
    .bind(email)
    .first<{ token: string; status: string }>();

  let token = existing?.token;
  if (!existing) {
    token = newToken();
    await env.DB.prepare("INSERT INTO subscribers (email, token, status, created_at) VALUES (?, ?, 'pending', ?)")
      .bind(email, token, now)
      .run();
  } else if (existing.status === "unsubscribed") {
    await env.DB.prepare("UPDATE subscribers SET status = 'pending', unsubscribed_at = NULL WHERE email = ?")
      .bind(email)
      .run();
  }

  if (existing?.status !== "confirmed" && token && sendingEnabled(env)) {
    const site = env.SITE_URL || new URL(request.url).origin;
    await send(env, confirmationMail(site, email, token));
    return json({ ok: true, message: "You’re on the list. Check your inbox to confirm." });
  }
  return json({ ok: true, message: "You’re on the list. The first brief goes out as soon as sending opens." });
}

export function onRequest(): Response {
  return json({ error: "Use POST." }, 405, { Allow: "POST" });
}
