/**
 * Outbound email for the Morning Brief sign-up flow.
 *
 * Sending is OFF until EMAIL_PROVIDER is set in the Pages project's
 * environment variables. Supported today: "resend" (with RESEND_API_KEY
 * and MAIL_FROM on a domain verified in Resend). With no provider, sign-ups
 * are stored as pending and nothing is sent.
 */
import type { Env } from "./http.ts";

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export function sendingEnabled(env: Env): boolean {
  return env.EMAIL_PROVIDER === "resend" && Boolean(env.RESEND_API_KEY && env.MAIL_FROM);
}

const apiBase = (env: Env) => (env.RESEND_API_BASE || "https://api.resend.com").replace(/\/$/, "");

export async function send(env: Env, mail: Mail): Promise<boolean> {
  if (!sendingEnabled(env)) return false;
  const res = await fetch(`${apiBase(env)}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  return res.ok;
}

export function confirmationMail(site: string, email: string, token: string): Mail {
  const confirm = `${site}/api/confirm?token=${token}`;
  const leave = `${site}/api/unsubscribe?token=${token}`;
  return {
    to: email,
    subject: "Confirm your AURA Morning Brief",
    text: `Confirm your subscription to the AURA Morning Brief:\n${confirm}\n\nDidn't ask for this? Ignore this email, or remove yourself: ${leave}`,
    html: `<div style="font-family:Georgia,serif;max-width:520px;margin:auto;padding:24px;color:#1b1a17">
<p style="letter-spacing:.14em;font:600 12px system-ui;color:#9c7420">AURA · MORNING BRIEF</p>
<h1 style="font-weight:500">One click to confirm.</h1>
<p style="font:16px/1.6 system-ui">You asked for the AURA Morning Brief: Nigeria's ownership changes, board moves and contracts, at 08:00 Lagos.</p>
<p><a href="${confirm}" style="display:inline-block;background:#1e3fae;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font:600 15px system-ui">Confirm my subscription</a></p>
<p style="font:13px/1.6 system-ui;color:#6b6558">Didn't ask for this? Ignore this email, or <a href="${leave}">remove this address</a>.</p></div>`,
  };
}

/* ---------- The daily Morning Brief ---------- */

/** One subscriber's copy: the brief with their own unsubscribe link. */
export interface BriefMail extends Mail {
  unsubscribe: string;
}

export function unsubscribeUrl(site: string, token: string): string {
  return `${site.replace(/\/$/, "")}/api/unsubscribe?token=${token}`;
}

/** Fills the template's {{unsubscribe_url}} placeholder. */
export function personalise(html: string, unsubscribe: string): string {
  return html.split("{{unsubscribe_url}}").join(unsubscribe.replace(/&/g, "&amp;"));
}

/** A readable plain-text part for clients that do not show HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => `${label.replace(/<[^>]+>/g, "").trim()} (${href})`)
    .replace(/<\/(tr|p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&#x27;/g, "’")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, i, all) => line || (all[i - 1] ?? "") !== "")
    .join("\n")
    .trim();
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The Resend batch payload: one email per subscriber, with one-click unsubscribe headers (RFC 8058). */
export function batchPayload(from: string, mails: BriefMail[]) {
  return mails.map((m) => ({
    from,
    to: [m.to],
    subject: m.subject,
    html: m.html,
    text: m.text,
    headers: {
      "List-Unsubscribe": `<${m.unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  }));
}

/** Sends up to 100 emails per Resend batch call. Returns how many were accepted and how many failed. */
export async function sendBatch(env: Env, mails: BriefMail[]): Promise<{ sent: number; failed: number }> {
  if (!sendingEnabled(env)) return { sent: 0, failed: mails.length };
  let sent = 0;
  let failed = 0;
  for (const group of chunk(mails, 100)) {
    try {
      const res = await fetch(`${apiBase(env)}/emails/batch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(batchPayload(env.MAIL_FROM!, group)),
      });
      if (res.ok) sent += group.length;
      else failed += group.length;
    } catch {
      failed += group.length;
    }
  }
  return { sent, failed };
}
