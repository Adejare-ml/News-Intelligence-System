import { test } from "node:test";
import assert from "node:assert/strict";
import { sendBriefs, smtpTransport } from "./mailer.ts";
import { fakeSmtp } from "./smtp-fake.test.ts";
import type { Env } from "./http.ts";

test("gmail: a login failure is reported even when the cap is also hit", async () => {
  const server = fakeSmtp({ password: "rightpasswordxyz" });
  const realOpen = smtpTransport.open;
  smtpTransport.open = () => server.open;
  try {
    const env: Env = { EMAIL_PROVIDER: "gmail", GMAIL_USER: "me@gmail.com", GMAIL_APP_PASSWORD: "wrongpasswordxyz" };
    const job = (n: number, tag: string) => ({
      brief: { subject: tag, html: `<p>${tag}</p><a href="{{unsubscribe_url}}">u</a>`, text: tag },
      recipients: Array.from({ length: n }, (_, i) => ({ to: `${tag}${i}@x.co`, unsubscribe: `https://s/api/unsubscribe?token=${i}` })),
    });
    const result = await sendBriefs(env, [job(200, "a"), job(200, "b"), job(200, "c")]);
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 600);
    assert.match(result.error ?? "", /login|535|auth/i);
    assert.match(result.error ?? "", /Gmail daily cap: 150 not sent/);
  } finally {
    smtpTransport.open = realOpen;
  }
});
