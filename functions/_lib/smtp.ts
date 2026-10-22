/**
 * A small SMTP client for sending through Gmail (smtp.gmail.com:465, implicit
 * TLS) from a Pages Function.
 *
 * Built to stay inside a Function's CPU budget: the email is encoded once
 * (quoted-printable, already safe for SMTP's DATA), and each subscriber's
 * copy only swaps in their unsubscribe link. One session sends every copy,
 * with MAIL/RCPT/DATA pipelined (RFC 2920), which Gmail supports.
 *
 * The socket is injected: production opens it with `cloudflare:sockets`;
 * tests pass an in-memory fake.
 */

export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

export type OpenSocket = () => Promise<SmtpSocket>;

export interface SmtpLogin {
  user: string;
  password: string;
}

/** One message on the wire: envelope addresses and DATA content (dot-safe, CRLF). */
export interface Envelope {
  from: string;
  to: string;
  data: () => string;
}

/** Opens a TLS socket from a Pages Function. Port 25 is blocked there; 465 is not. */
export function cloudflareSocket(hostname = "smtp.gmail.com", port = 465): OpenSocket {
  return async () => (await import("./cf-socket.ts")).openTls(hostname, port);
}

const enc = new TextEncoder();

export function b64(text: string): string {
  let bin = "";
  for (const byte of enc.encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

const hex = (b: number) => `=${b.toString(16).toUpperCase().padStart(2, "0")}`;

/**
 * Quoted-printable (RFC 2045), soft-wrapped under 76 columns, with any line
 * that would start with "." escaped, so the result can go straight into DATA.
 */
export function qpEncode(text: string): string {
  const lines = text.replace(/\r\n|\r|\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    // eslint-disable-next-line no-control-regex
    let q = line.replace(/[=\x00-\x08\x0b-\x1f\x7f-￿]/g, (ch) => Array.from(enc.encode(ch), hex).join(""));
    q = q.replace(/[ \t]$/, (ch) => hex(ch.charCodeAt(0)));
    let rest = q;
    while (rest.length > 73) {
      let cut = 73;
      const eq = rest.lastIndexOf("=", cut - 1);
      if (eq > cut - 3) cut = eq; // never split an =XX escape
      out.push(`${rest.slice(0, cut)}=`);
      rest = rest.slice(cut);
    }
    out.push(rest);
  }
  return out.map((l) => (l.startsWith(".") ? `=2E${l.slice(1)}` : l)).join("\r\n");
}

/** RFC 2047 encoded word for headers that are not plain ASCII. */
export function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`;
}

export function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

function encodeAddress(from: string): string {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!m) return `<${from.trim()}>`;
  return m[1] ? `${encodeHeader(m[1])} <${m[2].trim()}>` : `<${m[2].trim()}>`;
}

export const PLACEHOLDER = "{{unsubscribe_url}}";

/**
 * Compiles a message once. The returned function builds one recipient's copy
 * by string substitution only: their address, their unsubscribe link (in the
 * HTML, the text and the List-Unsubscribe header) and a fresh Message-ID.
 */
export function compileMessage(m: { from: string; subject: string; html: string; text: string }) {
  const boundary = `aura-${crypto.randomUUID()}`;
  const domain = addressOf(m.from).split("@")[1] || "localhost";
  // Each placeholder sits on its own soft-wrapped line, so inserting a link never breaks the encoding.
  const isolate = (body: string) => body.split(PLACEHOLDER).map(qpEncode).join(`=\r\n${PLACEHOLDER}=\r\n`);
  const htmlQp = isolate(m.html);
  const textQp = isolate(m.text);
  const fixed = [
    `From: ${encodeAddress(m.from)}`,
    `Subject: ${encodeHeader(m.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join("\r\n");
  const part = (type: string) => `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n`;

  return (to: string, unsubscribe?: string, now = new Date()): string => {
    const head = [
      fixed,
      `To: <${to}>`,
      `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
      `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    ];
    if (unsubscribe) head.push(`List-Unsubscribe: <${unsubscribe}>`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    const link = unsubscribe ?? "";
    const html = htmlQp.split(PLACEHOLDER).join(qpEncode(link.replace(/&/g, "&amp;")));
    const text = textQp.split(PLACEHOLDER).join(qpEncode(link));
    return `${head.join("\r\n")}\r\n\r\n${part("text/plain")}${text}\r\n${part("text/html")}${html}\r\n--${boundary}--`;
  };
}

/** Reads SMTP replies (including multi-line "250-..." ones) from a stream. */
class Replies {
  private buffer = "";
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }
  async next(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const nl = this.buffer.indexOf("\r\n");
      if (nl === -1) {
        const { value, done } = await this.reader.read();
        if (done) throw new Error("SMTP connection closed");
        this.buffer += this.decoder.decode(value, { stream: true });
        continue;
      }
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 2);
      lines.push(line);
      if (/^\d{3}( |$)/.test(line)) return { code: Number(line.slice(0, 3)), text: lines.join("\n") };
    }
  }
  release() {
    try {
      this.reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/**
 * Sends every envelope over one authenticated session. A message the server
 * refuses is counted as failed and the session carries on (RSET); a failed
 * login or a lost connection fails everything not yet sent.
 */
export async function smtpSend(
  open: OpenSocket,
  login: SmtpLogin,
  envelopes: Envelope[],
): Promise<{ sent: number; failed: number; error?: string }> {
  if (!envelopes.length) return { sent: 0, failed: 0 };
  let sent = 0;
  let refused = 0;
  let lastRefusal = "";
  let socket: SmtpSocket | undefined;
  let replies: Replies | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    socket = await open();
    const r = (replies = new Replies(socket.readable));
    const w = (writer = socket.writable.getWriter());
    const write = (s: string) => w.write(enc.encode(s));
    const expect = async (codes: number[], what: string) => {
      const reply = await r.next();
      if (!codes.includes(reply.code)) throw new Error(`${what}: ${reply.text}`);
      return reply;
    };

    await expect([220], "greeting");
    await write("EHLO auranews.pages.dev\r\n");
    await expect([250], "EHLO");
    await write("AUTH LOGIN\r\n");
    await expect([334], "AUTH");
    await write(`${b64(login.user)}\r\n`);
    await expect([334], "AUTH user");
    await write(`${b64(login.password)}\r\n`);
    await expect([235], "login");

    for (const e of envelopes) {
      await write(`MAIL FROM:<${addressOf(e.from)}>\r\nRCPT TO:<${e.to}>\r\nDATA\r\n`);
      const mail = await r.next();
      const rcpt = await r.next();
      const data = await r.next();
      if (data.code === 354) {
        await write(`${e.data()}\r\n.\r\n`);
        const done = await r.next();
        if (done.code === 250) {
          sent++;
          continue;
        }
        lastRefusal = done.text;
      } else {
        lastRefusal = [mail, rcpt, data].find((x) => x.code >= 400)?.text ?? data.text;
      }
      refused++;
      await write("RSET\r\n");
      await expect([250], "RSET");
    }
    await write("QUIT\r\n");
    await r.next().catch(() => undefined);
    return { sent, failed: envelopes.length - sent, ...(refused ? { error: lastRefusal } : {}) };
  } catch (e) {
    return { sent, failed: envelopes.length - sent, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      writer?.releaseLock();
    } catch {
      /* ignore */
    }
    replies?.release();
    await socket?.close().catch(() => undefined);
  }
}
