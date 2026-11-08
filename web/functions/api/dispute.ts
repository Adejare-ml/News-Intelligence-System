/**
 * POST /api/dispute  { name, email, relationship, ref, message, company_site }
 *
 * Right of reply. Anyone named on the site (or acting for them) can say a
 * record is wrong. The dispute is stored in D1 (table disputes, migration
 * 0005) for the owner to review, and the owner is emailed when sending is
 * on. The /dispute/ page posts JSON from its script; without JavaScript the
 * browser posts the form and gets a small page back instead.
 *
 * Every accepted post gets the same answer, whether it was stored, caught by
 * the honeypot or over the daily limit, so the response teaches a bot nothing.
 * Only a mistake the sender can fix (a missing field) gets its own message.
 */
import { escapeHtml, json, page, readBody, validEmail, type Ctx, type D1Like, type Env } from "../_lib/http.ts";
import { send, sendingEnabled } from "../_lib/mailer.ts";

export const DISPUTE_RECEIVED =
  "Thank you. Your message has been received. Every dispute is read, and we reply to the email address you gave.";

const RELATIONSHIPS = ["subject", "representative", "other"] as const;
const MAX_MESSAGE = 4000;
const MAX_FIELD = 200;
const DAILY_LIMIT = 5;

interface Dispute {
  name: string;
  email: string;
  relationship: string;
  ref: string;
  message: string;
}

/** The dispute, or the one thing the sender has to fix. */
function parse(body: Record<string, unknown>): Dispute | { error: string } {
  // One line, so a reference or name can never break the owner's email subject.
  const line = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
  const name = line(body.name);
  const ref = line(body.ref);
  const relationship = line(body.relationship);
  const message = String(body.message ?? "").trim();
  const email = validEmail(body.email);
  if (!name || name.length > MAX_FIELD) return { error: "Please give your name." };
  if (!email) return { error: "That email address doesn’t look right." };
  if (!(RELATIONSHIPS as readonly string[]).includes(relationship)) return { error: "Please choose who you are in relation to the record." };
  if (!ref || ref.length > MAX_FIELD) return { error: "Please say which record you are disputing." };
  if (!message) return { error: "Please say what is wrong with the record." };
  if (message.length > MAX_MESSAGE) return { error: "Please keep your message under 4,000 characters." };
  return { name, email, relationship, ref, message };
}

/**
 * DISPUTE_SECRET is a Pages secret: the key for the throttle codes below.
 * Kept out of the shared Env, since only this endpoint uses it.
 */
export type DisputeEnv = Env & { DISPUTE_SECRET?: string };

/**
 * A stable key for the sender, so their IP address is never stored. It is an
 * HMAC under a secret: a plain hash with a salt in this public repo could be
 * reversed by hashing every IPv4 address.
 */
async function senderKey(request: Request, secret: string): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(ip));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Deletes throttle codes from before `day` (YYYY-MM-DD, UTC, as the rows are
 * keyed): only today's counts limit anyone. The form does this as it is
 * used, and the daily brief send does it too, so a code is gone the next
 * day even when no dispute follows.
 */
export async function pruneDisputeThrottle(db: D1Like, day: string): Promise<void> {
  await db.prepare("DELETE FROM dispute_throttle WHERE day < ?").bind(day).run();
}

/** Counts this post against the sender's day; true while they are within the limit. */
async function withinLimit(env: Env, key: string, day: string): Promise<boolean> {
  await pruneDisputeThrottle(env.DB!, day);
  const row = await env.DB!.prepare(
    "INSERT INTO dispute_throttle (key, day, count) VALUES (?, ?, 1) ON CONFLICT(key, day) DO UPDATE SET count = count + 1 RETURNING count",
  )
    .bind(key, day)
    .first<{ count: number }>();
  return (row?.count ?? 0) <= DAILY_LIMIT;
}

function ownerMail(to: string, d: Dispute, when: string) {
  const text =
    `A dispute was sent from the AURA site.\n\nRecord: ${d.ref}\nFrom: ${d.name} <${d.email}>\n` +
    `Relationship: ${d.relationship}\nReceived: ${when}\n\n${d.message}\n\n` +
    "It is stored in the disputes table (status open). Reply to the sender by email.";
  const html =
    `<div style="font:15px/1.6 system-ui,sans-serif;max-width:560px;margin:auto;padding:24px;color:#1b1a17">` +
    `<p style="letter-spacing:.14em;font:600 12px system-ui;color:#9c7420">AURA · DISPUTE</p>` +
    `<p><strong>Record:</strong> ${escapeHtml(d.ref)}<br><strong>From:</strong> ${escapeHtml(d.name)} &lt;${escapeHtml(d.email)}&gt;` +
    `<br><strong>Relationship:</strong> ${escapeHtml(d.relationship)}<br><strong>Received:</strong> ${escapeHtml(when)}</p>` +
    `<p style="white-space:pre-wrap">${escapeHtml(d.message)}</p>` +
    `<p style="color:#6b6558;font-size:13px">Stored in the disputes table (status open). Reply to the sender by email.</p></div>`;
  return { to, subject: `AURA dispute: ${d.ref}`, text, html };
}

export async function onRequestPost({ request, env }: Ctx & { env: DisputeEnv }): Promise<Response> {
  // The page's script sends JSON; a browser without JavaScript sends the form.
  const wantsPage = !(request.headers.get("Content-Type") || "").includes("application/json");
  const reply = (title: string, message: string, status: number) => {
    if (!wantsPage) return json(status === 200 ? { ok: true, message } : { error: message }, status);
    // The browser's Back button keeps what they typed; a fresh link would not.
    return page(title, status === 200 ? message : `${message} Use your browser’s Back button to return to the form.`, status);
  };
  const received = () => reply("Thank you", DISPUTE_RECEIVED, 200);

  const body = await readBody(request);
  if (!body) return reply("Something went wrong", "Could not read the form.", 400);

  // Honeypot: a filled hidden field means a bot. Answer as if it worked.
  if (String(body.company_site ?? "").trim()) return received();

  const parsed = parse(body);
  if ("error" in parsed) return reply("Please check the form", parsed.error, 400);

  if (!env.DB || !env.DISPUTE_SECRET) return reply("Not open yet", "The dispute form opens very soon. Please try again later.", 503);

  const now = new Date().toISOString();
  if (!(await withinLimit(env, await senderKey(request, env.DISPUTE_SECRET), now.slice(0, 10)))) return received();

  await env.DB.prepare("INSERT INTO disputes (created_at, ref, name, email, relationship, message) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(now, parsed.ref, parsed.name, parsed.email, parsed.relationship, parsed.message)
    .run();

  if (sendingEnabled(env) && env.OWNER_EMAIL) {
    // The dispute is already stored; a failed email must not change the answer.
    await send(env, ownerMail(env.OWNER_EMAIL, parsed, now)).catch(() => false);
  }
  return received();
}

export function onRequest(): Response {
  return json({ error: "Use POST." }, 405, { Allow: "POST" });
}
