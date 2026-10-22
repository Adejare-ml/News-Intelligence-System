/**
 * Outbound email for the Morning Brief sign-up flow and the daily brief.
 *
 * Sending is OFF until EMAIL_PROVIDER is set in the Pages project's
 * environment variables. Supported:
 *   "resend"  RESEND_API_KEY, and MAIL_FROM on a domain verified in Resend.
 *   "brevo"   BREVO_API_KEY, and MAIL_FROM on a sender verified in Brevo.
 *             No domain needed: Brevo sends unauthenticated free-mail
 *             senders from its own domain.
 *   "gmail"   GMAIL_USER and GMAIL_APP_PASSWORD (a Google App Password).
 *             Sent from your own Gmail over SMTP; about 500 a day.
 * With no provider, sign-ups are stored as pending and nothing is sent.
 */
import type { Env } from "./http.ts";
import { cloudflareSocket, compileMessage, smtpSend, PLACEHOLDER, type OpenSocket } from "./smtp.ts";

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

type Provider = "resend" | "brevo" | "gmail";

export function provider(env: Env): Provider | null {
  if (env.EMAIL_PROVIDER === "gmail") return env.GMAIL_USER && env.GMAIL_APP_PASSWORD ? "gmail" : null;
  if (!env.MAIL_FROM) return null;
  if (env.EMAIL_PROVIDER === "resend" && env.RESEND_API_KEY) return "resend";
  if (env.EMAIL_PROVIDER === "brevo" && env.BREVO_API_KEY) return "brevo";
  return null;
}

/** Gmail's sender: MAIL_FROM when it is the same address, otherwise the Gmail address with the AURA name. */
export function gmailFrom(env: Env): string {
  const user = env.GMAIL_USER!.trim();
  const from = env.MAIL_FROM?.trim();
  if (from && from.toLowerCase().includes(`<${user.toLowerCase()}>`)) return from;
  return `AURA Morning Brief <${user}>`;
}

/** Gmail allows about 500 recipients a day on a personal account; stay under it. */
export const GMAIL_DAILY_CAP = 450;

/** How Gmail sockets are opened; tests swap this for an in-memory server. */
export const smtpTransport = {
  open: (env: Env): OpenSocket => cloudflareSocket(env.SMTP_HOST || "smtp.gmail.com", Number(env.SMTP_PORT) || 465),
};

const gmailLogin = (env: Env) => ({ user: env.GMAIL_USER!.trim(), password: env.GMAIL_APP_PASSWORD!.replace(/\s+/g, "") });

export function sendingEnabled(env: Env): boolean {
  return provider(env) !== null;
}

const apiBase = (env: Env) => (env.RESEND_API_BASE || "https://api.resend.com").replace(/\/$/, "");
const brevoBase = (env: Env) => (env.BREVO_API_BASE || "https://api.brevo.com").replace(/\/$/, "");

/** "AURA Morning Brief <brief@example.org>" -> { name, email }. */
export function parseFrom(from: string): { name?: string; email: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!m) return { email: from.trim() };
  return m[1] ? { name: m[1], email: m[2].trim() } : { email: m[2].trim() };
}

const brevoHeaders = (env: Env) => ({ "api-key": env.BREVO_API_KEY!, "Content-Type": "application/json", Accept: "application/json" });

export async function send(env: Env, mail: Mail): Promise<boolean> {
  const via = provider(env);
  if (!via) return false;
  if (via === "gmail") {
    const from = gmailFrom(env);
    const build = compileMessage({ from, subject: mail.subject, html: mail.html, text: mail.text });
    const result = await smtpSend(smtpTransport.open(env), gmailLogin(env), [{ from, to: mail.to, data: () => build(mail.to) }]);
    return result.sent === 1;
  }
  if (via === "brevo") {
    const res = await fetch(`${brevoBase(env)}/v3/smtp/email`, {
      method: "POST",
      headers: brevoHeaders(env),
      body: JSON.stringify({
        sender: parseFrom(env.MAIL_FROM!),
        to: [{ email: mail.to }],
        subject: mail.subject,
        htmlContent: mail.html,
        textContent: mail.text,
      }),
    });
    return res.ok;
  }
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

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", mdash: "—", ndash: "–", middot: "·",
};

/** Decodes the few named and numeric entities the template uses, in one pass (never twice). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    const key = name.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return match;
  });
}

const BLOCK_END = new Set(["tr", "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table"]);
const SKIP = new Set(["head", "style", "script", "title"]);

/**
 * A readable plain-text part for clients that do not show HTML. A small
 * tag scanner, not regex stripping: text outside tags is kept, links keep
 * their address, block ends become line breaks, and head/style/script
 * contents are dropped. The result is plain text, never rendered as HTML.
 */
export function htmlToText(html: string): string {
  let out = "";
  let skipping = "";
  let href = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    const textEnd = lt === -1 ? html.length : lt;
    if (!skipping) out += html.slice(i, textEnd);
    if (lt === -1) break;
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    const tag = html.slice(lt + 1, gt);
    const closing = tag.startsWith("/");
    const name = (closing ? tag.slice(1) : tag).trim().split(/[\s/]/)[0].toLowerCase();
    if (skipping) {
      if (closing && name === skipping) skipping = "";
    } else if (!closing && SKIP.has(name)) {
      skipping = name;
    } else if (!closing && name === "a") {
      const m = tag.match(/href="([^"]*)"/i);
      href = m ? decodeEntities(m[1]) : "";
    } else if (closing && name === "a") {
      if (href && (/^https?:/.test(href) || href === PLACEHOLDER)) out += ` (${href})`;
      href = "";
    } else if (name === "br" || (closing && BLOCK_END.has(name))) {
      out += "\n";
    }
    i = gt + 1;
  }
  return decodeEntities(out)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, idx, all) => line || (all[idx - 1] ?? "") !== "")
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

/**
 * The Brevo batch payload: one message version per subscriber, each with
 * its own HTML (and so its own unsubscribe link). The shared base content
 * carries no subscriber's link.
 */
export function brevoBatchPayload(from: string, mails: BriefMail[]) {
  return {
    sender: parseFrom(from),
    subject: mails[0]?.subject ?? "",
    htmlContent: "<p>AURA Morning Brief</p>",
    messageVersions: mails.map((m) => ({ to: [{ email: m.to }], subject: m.subject, htmlContent: m.html })),
  };
}

/**
 * Sends the brief in batches (Resend: 100 per call; Brevo: 50 per call).
 * Few calls per run, well inside a Pages Function's subrequest limit.
 * Returns how many were accepted and how many failed.
 */
export async function sendBatch(env: Env, mails: BriefMail[]): Promise<{ sent: number; failed: number; error?: string }> {
  const via = provider(env);
  if (!via) return { sent: 0, failed: mails.length };
  if (via === "gmail") {
    const from = gmailFrom(env);
    return smtpSend(
      smtpTransport.open(env),
      gmailLogin(env),
      mails.slice(0, GMAIL_DAILY_CAP).map((m) => {
        const build = compileMessage({ from, subject: m.subject, html: m.html, text: m.text });
        return { from, to: m.to, data: () => build(m.to, m.unsubscribe) };
      }),
    ).then((r) => ({ ...r, failed: r.failed + Math.max(0, mails.length - GMAIL_DAILY_CAP) }));
  }
  let sent = 0;
  let failed = 0;
  for (const group of chunk(mails, via === "brevo" ? 50 : 100)) {
    try {
      const res =
        via === "brevo"
          ? await fetch(`${brevoBase(env)}/v3/smtp/email`, {
              method: "POST",
              headers: brevoHeaders(env),
              body: JSON.stringify(brevoBatchPayload(env.MAIL_FROM!, group)),
            })
          : await fetch(`${apiBase(env)}/emails/batch`, {
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

export interface BriefTemplate {
  subject: string;
  /** The email HTML with the {{unsubscribe_url}} placeholder. */
  html: string;
  /** The plain-text part with the same placeholder. */
  text: string;
}

/** Fills the placeholder in the plain-text part (no HTML escaping). */
export function personaliseText(text: string, unsubscribe: string): string {
  return text.split(PLACEHOLDER).join(unsubscribe);
}

/**
 * Sends one brief to many people, each with their own unsubscribe link.
 * Gmail encodes the email once and only swaps the link per person, so a
 * large list stays inside a Function's CPU budget.
 */
export async function sendBrief(
  env: Env,
  brief: BriefTemplate,
  recipients: { to: string; unsubscribe: string }[],
): Promise<{ sent: number; failed: number; error?: string }> {
  if (provider(env) === "gmail") {
    const from = gmailFrom(env);
    const build = compileMessage({ from, ...brief });
    const allowed = recipients.slice(0, GMAIL_DAILY_CAP);
    const result = await smtpSend(
      smtpTransport.open(env),
      gmailLogin(env),
      allowed.map((r) => ({ from, to: r.to, data: () => build(r.to, r.unsubscribe) })),
    );
    const over = recipients.length - allowed.length;
    return over > 0
      ? { ...result, failed: result.failed + over, error: `Gmail daily cap: ${over} not sent` }
      : result;
  }
  return sendBatch(
    env,
    recipients.map((r) => ({
      to: r.to,
      subject: brief.subject,
      html: personalise(brief.html, r.unsubscribe),
      text: personaliseText(brief.text, r.unsubscribe),
      unsubscribe: r.unsubscribe,
    })),
  );
}
