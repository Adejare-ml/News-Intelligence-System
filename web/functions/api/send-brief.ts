/**
 * POST /api/send-brief   Authorization: Bearer <BRIEF_SEND_SECRET>
 *
 * Emails today's Morning Brief to every confirmed subscriber. Called by the
 * scheduler after the 08:00 Lagos run has been published, so the brief it
 * sends is the one the site shows. Subscriber addresses never leave
 * Cloudflare: GitHub only holds the secret that triggers this.
 *
 *   ?dry_run=1  report the edition, subject and recipient count; send nothing
 *   ?test=1     send one copy to OWNER_EMAIL; record nothing
 *
 * Safe to call twice: one send per Lagos day, and an edition that was
 * already sent (the pipeline produced nothing new) is never sent again.
 */
import { json, type Ctx, type Env } from "../_lib/http.ts";
import {
  decodeEntities, htmlToText, sendBrief, sendingEnabled, unsubscribeUrl,
} from "../_lib/mailer.ts";

/** Constant-time string comparison, so the secret cannot be guessed by timing. */
export function sameSecret(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function authorised(request: Request, env: Env): boolean {
  const secret = env.BRIEF_SEND_SECRET || "";
  const header = request.headers.get("Authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return secret.length >= 16 && given.length > 0 && sameSecret(given, secret);
}

export function lagosDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function readMeta(html: string, name: string): string {
  const m = html.match(new RegExp(`<meta[^>]+name="${name}"[^>]+content="([^"]*)"`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

/**
 * The site adds its prefetch script to every page, the email page too. Mail
 * clients never run it, and some flag scripts, so each <script> element is
 * cut out (repeatedly, until none is left) before sending.
 */
export function stripScripts(html: string): string {
  let out = html;
  for (;;) {
    const lower = out.toLowerCase();
    const start = lower.indexOf("<script");
    if (start === -1) return out;
    const close = lower.indexOf("</script>", start);
    const end = close === -1 ? out.length : close + "</script>".length;
    out = out.slice(0, start) + out.slice(end);
  }
}

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  if (!env.BRIEF_SEND_SECRET) return json({ error: "Sending is not configured (BRIEF_SEND_SECRET)." }, 503);
  if (!authorised(request, env)) return json({ error: "Not authorised." }, 401);

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const test = url.searchParams.get("test") === "1";
  if (!env.DB) return json({ error: "Subscriber database (DB) is not bound." }, 503);
  if (!dryRun && !sendingEnabled(env)) return json({ error: "Email provider is not configured." }, 503);
  if (!env.ASSETS) return json({ error: "Static assets are unavailable." }, 503);

  // The email is the page the site built from this edition's data.
  const templateRes = await env.ASSETS.fetch(new Request(new URL("/brief/email/", url.origin)));
  if (!templateRes.ok) return json({ error: "The email template page is missing." }, 500);
  const template = stripScripts(await templateRes.text());
  const edition = readMeta(template, "aura-edition");
  const subject = readMeta(template, "aura-subject") || "AURA Morning Brief";
  if (!edition) return json({ error: "The template does not name its edition." }, 500);

  const site = (env.SITE_URL || url.origin).replace(/\/$/, "");
  const day = lagosDay(new Date());
  // The text part is derived once; each copy only swaps in its unsubscribe link.
  const brief = { subject, html: template, text: htmlToText(template) };

  if (test) {
    if (!env.OWNER_EMAIL) return json({ error: "Set OWNER_EMAIL to receive a test copy." }, 400);
    const result = await sendBrief(env, brief, [{ to: env.OWNER_EMAIL, unsubscribe: `${site}/api/unsubscribe` }]);
    return json({ test: true, edition, subject, ...result });
  }

  const today = await env.DB.prepare("SELECT edition, finished_at FROM sends WHERE day = ?")
    .bind(day).first<{ edition: string; finished_at: string | null }>();
  if (today?.finished_at) return json({ skipped: "already_sent_today", day, edition: today.edition });
  if (today) return json({ skipped: "send_in_progress_or_incomplete", day }, 409);

  const before = await env.DB.prepare("SELECT day FROM sends WHERE edition = ? AND finished_at IS NOT NULL")
    .bind(edition).first<{ day: string }>();
  if (before) return json({ skipped: "edition_already_sent", edition, sent_on: before.day });

  const { results } = await env.DB.prepare("SELECT email, token FROM subscribers WHERE status = 'confirmed'")
    .bind().all<{ email: string; token: string }>();
  const recipients = results ?? [];

  if (dryRun) return json({ dry_run: true, day, edition, subject, recipients: recipients.length });

  await env.DB.prepare("INSERT INTO sends (day, edition, started_at) VALUES (?, ?, ?)")
    .bind(day, edition, new Date().toISOString()).run();
  const result = await sendBrief(env, brief, recipients.map((r) => ({ to: r.email, unsubscribe: unsubscribeUrl(site, r.token) })));
  await env.DB.prepare("UPDATE sends SET finished_at = ?, sent = ?, failed = ? WHERE day = ?")
    .bind(new Date().toISOString(), result.sent, result.failed, day).run();

  return json({ day, edition, subject, recipients: recipients.length, ...result }, result.failed && !result.sent ? 502 : 200);
}

export function onRequest(): Response {
  return json({ error: "Use POST." }, 405, { Allow: "POST" });
}
