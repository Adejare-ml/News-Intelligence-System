/** GET /api/confirm?token=...  Double opt-in: marks a pending address confirmed. */
import { page, type Ctx } from "../_lib/http.ts";

export async function onRequestGet({ request, env }: Ctx): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!/^[a-f0-9]{48}$/.test(token) || !env.DB) {
    return page("Link not recognised", "This confirmation link is invalid or has expired.", 400);
  }
  const row = await env.DB.prepare("SELECT status FROM subscribers WHERE token = ?").bind(token).first<{ status: string }>();
  if (!row) return page("Link not recognised", "This confirmation link is invalid or has expired.", 404);
  if (row.status !== "confirmed") {
    await env.DB.prepare("UPDATE subscribers SET status = 'confirmed', confirmed_at = ?, unsubscribed_at = NULL WHERE token = ?")
      .bind(new Date().toISOString(), token)
      .run();
  }
  return page("You’re in.", "The AURA Morning Brief arrives at 08:00 Lagos time. Every email has a one-click unsubscribe link.");
}
