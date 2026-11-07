import { test } from "node:test";
import assert from "node:assert/strict";
import { batchPayload, brevoBatchPayload, confirmationMail, replyTo, send, sendBrief, smtpTransport } from "./mailer.ts";
import { compileMessage } from "./smtp.ts";
import { fakeSmtp } from "./smtp-fake.test.ts";
import type { Env } from "./http.ts";

const mail = { to: "r@x.co", subject: "s", html: "<p>h</p>", text: "t", unsubscribe: "https://x/u" };

test("replies go to REPLY_TO, else OWNER_EMAIL, else nowhere", () => {
  assert.equal(replyTo({ REPLY_TO: " Desk <desk@x.org> ", OWNER_EMAIL: "o@x.org" }), "Desk <desk@x.org>");
  assert.equal(replyTo({ OWNER_EMAIL: "o@x.org" }), "o@x.org");
  assert.equal(replyTo({}), undefined);
  assert.equal(replyTo({ REPLY_TO: "a@x.org\r\nBcc: b@x.org" }), undefined, "a line break could forge headers");
});

test("the Resend and Brevo batches carry the reply address", () => {
  assert.equal(batchPayload("F", [mail], "o@x.org")[0].reply_to, "o@x.org");
  assert.equal("reply_to" in batchPayload("F", [mail])[0], false);
  assert.deepEqual(brevoBatchPayload("F <f@x.org>", [mail], "Desk <desk@x.org>").replyTo, { name: "Desk", email: "desk@x.org" });
  assert.equal("replyTo" in brevoBatchPayload("F <f@x.org>", [mail]), false);
});

test("a Gmail message gets a Reply-To header only when one is set", () => {
  const withReply = compileMessage({ from: "A <a@gmail.com>", replyTo: "Desk <desk@x.org>", subject: "s", html: "h", text: "t" })("r@x.co");
  assert.match(withReply, /^Reply-To: Desk <desk@x\.org>$/m);
  const without = compileMessage({ from: "A <a@gmail.com>", subject: "s", html: "h", text: "t" })("r@x.co");
  assert.doesNotMatch(without, /^Reply-To:/m);
});

async function capture(env: Env, fn: () => Promise<unknown>): Promise<any[]> {
  const bodies: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}");
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return bodies;
}

test("confirmation mails and briefs set Reply-To with every provider", async () => {
  const site = "https://auranews.pages.dev";
  const confirm = confirmationMail(site, "r@x.co", "a".repeat(48));
  const brief = { subject: "s", html: "<p>h</p>", text: "t" };
  const readers = [{ to: "r@x.co", unsubscribe: `${site}/api/unsubscribe?token=${"a".repeat(48)}` }];

  const resend: Env = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k", MAIL_FROM: "A <a@x.org>", RESEND_API_BASE: "https://r.test", OWNER_EMAIL: "o@x.org" };
  const [one, batch] = await capture(resend, async () => {
    await send(resend, confirm);
    await sendBrief(resend, brief, readers);
  });
  assert.equal(one.reply_to, "o@x.org");
  assert.equal(batch[0].reply_to, "o@x.org");

  const brevo: Env = { EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "k", MAIL_FROM: "A <a@x.org>", BREVO_API_BASE: "https://b.test", REPLY_TO: "desk@x.org" };
  const [bOne, bBatch] = await capture(brevo, async () => {
    await send(brevo, confirm);
    await sendBrief(brevo, brief, readers);
  });
  assert.deepEqual(bOne.replyTo, { email: "desk@x.org" });
  assert.deepEqual(bBatch.replyTo, { email: "desk@x.org" });

  const server = fakeSmtp({ password: "abcdefghijklmnop" });
  const realOpen = smtpTransport.open;
  smtpTransport.open = () => server.open;
  try {
    const gmail: Env = { EMAIL_PROVIDER: "gmail", GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop", REPLY_TO: "desk@x.org" };
    await send(gmail, confirm);
    await sendBrief(gmail, brief, readers);
  } finally {
    smtpTransport.open = realOpen;
  }
  assert.equal(server.delivered.length, 2);
  for (const m of server.delivered) assert.match(m.data, /^Reply-To: <desk@x\.org>$/m);
});
