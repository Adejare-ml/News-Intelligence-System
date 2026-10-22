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
  /** Where ?test=1 sends a preview of the real brief. */
  OWNER_EMAIL?: string;
  /** Override for tests and local runs; defaults to https://api.resend.com. */
  RESEND_API_BASE?: string;
  /** Brevo (EMAIL_PROVIDER=brevo): works without a domain of your own. */
  BREVO_API_KEY?: string;
  /** Override for tests and local runs; defaults to https://api.brevo.com. */
  BREVO_API_BASE?: string;
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

export function page(title: string, message: string, status = 200): Response {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · AURA</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d14;color:#ede6d8;font:16px/1.6 system-ui,sans-serif;padding:24px}
main{max-width:460px}h1{font-family:Georgia,serif;font-weight:500;font-size:2rem;margin:0 0 12px}p{color:#c9c2b4}a{color:#d4a84a}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Back to AURA</a></p></main></body></html>`;
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
