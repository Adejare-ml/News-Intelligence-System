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

export async function send(env: Env, mail: Mail): Promise<boolean> {
  if (!sendingEnabled(env)) return false;
  const res = await fetch("https://api.resend.com/emails", {
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
