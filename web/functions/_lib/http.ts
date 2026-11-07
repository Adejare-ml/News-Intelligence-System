/** Shared helpers for AURA's Cloudflare Pages Functions. */

/** The slice of the D1 API these functions use. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

export interface Env {
  DB?: D1Like;
  ASSETS?: { fetch(input: Request | string): Promise<Response> };
  EMAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  SITE_URL?: string;
  /** Shared with the scheduler (GitHub secret of the same name); authorises /api/send-brief. */
  BRIEF_SEND_SECRET?: string;
  /** Where ?test=1 sends a preview of the real brief; also where replies go when REPLY_TO is unset. */
  OWNER_EMAIL?: string;
  /** Where readers' replies to the brief and to sign-up mails go ("Name <address>" or an address). */
  REPLY_TO?: string;
  /** Override for tests and local runs; defaults to https://api.resend.com. */
  RESEND_API_BASE?: string;
  /** Brevo (EMAIL_PROVIDER=brevo): works without a domain of your own. */
  BREVO_API_KEY?: string;
  /** Override for tests and local runs; defaults to https://api.brevo.com. */
  BREVO_API_BASE?: string;
  /** Gmail (EMAIL_PROVIDER=gmail): the Gmail address and a Google App Password. */
  GMAIL_USER?: string;
  GMAIL_APP_PASSWORD?: string;
  /** Overrides for local runs; default smtp.gmail.com:465. */
  SMTP_HOST?: string;
  SMTP_PORT?: string;
}

export interface Ctx {
  request: Request;
  env: Env;
  waitUntil?: (p: Promise<unknown>) => void;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

/**
 * A small standalone page for the sign-up links. `extraHtml` is trusted
 * markup the caller built (with escapeHtml) and goes after the message.
 */
export function page(title: string, message: string, status = 200, extraHtml = ""): Response {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · AURA</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d14;color:#ede6d8;font:16px/1.6 system-ui,sans-serif;padding:24px}
main{max-width:460px}h1{font-family:Georgia,serif;font-weight:500;font-size:2rem;margin:0 0 12px}p{color:#c9c2b4}a{color:#d4a84a}
fieldset{border:1px solid #2a2f40;border-radius:12px;margin:0 0 16px;padding:12px 16px}legend{color:#ede6d8;padding:0 6px;font-weight:600}
label{display:flex;gap:10px;align-items:center;padding:6px 0;cursor:pointer}input{accent-color:#d4a84a;width:18px;height:18px}
button{font:600 15px system-ui;background:#d4a84a;color:#0b0d14;border:0;border-radius:999px;padding:12px 22px;cursor:pointer}
.hint{font-size:.85rem;color:#8f887b;margin:4px 0 0}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p>${extraHtml}<p><a href="/">Back to AURA</a></p></main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const EMAIL_RE = /^[^\s@"<>]{1,64}@[^\s@"<>]{1,190}\.[a-z]{2,24}$/i;

export function validEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

export function newToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A JSON or form body as a plain object. Repeated form fields (checkboxes)
 * become arrays. Null when the body cannot be read.
 */
export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const type = request.headers.get("Content-Type") || "";
    if (type.includes("application/json")) {
      const body = await request.json();
      return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of (await request.formData()).entries()) {
      const v = String(value);
      const prev = out[key];
      out[key] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    return out;
  } catch {
    return null;
  }
}

/** Constant-time string comparison, so a secret cannot be guessed by timing. */
export function sameSecret(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** True when the request carries the owner's BRIEF_SEND_SECRET as a bearer token. */
export function authorised(request: Request, env: Env): boolean {
  const secret = env.BRIEF_SEND_SECRET || "";
  const header = request.headers.get("Authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return secret.length >= 16 && given.length > 0 && sameSecret(given, secret);
}

/** The date in Lagos (YYYY-MM-DD): the day sends and mail limits are counted by. */
export function lagosDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Subscriber tokens: 48 lowercase hex characters (see newToken). */
export const validToken = (token: string): boolean => /^[a-f0-9]{48}$/.test(token);

export const escapeHtml = (t: string): string =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
