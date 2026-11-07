import { test } from "node:test";
import assert from "node:assert/strict";
import { validEmail, newToken, json, page } from "./http.ts";
import { confirmationMail, sendingEnabled } from "./mailer.ts";

test("emails are validated and normalised", () => {
  assert.equal(validEmail(" Reader@Example.COM "), "reader@example.com");
  for (const bad of ["nope", "a@b", "a b@c.com", "<x>@y.com", "", null, `${"a".repeat(250)}@x.com`]) {
    assert.equal(validEmail(bad), null, String(bad));
  }
});

test("tokens are 48 hex chars and unique", () => {
  const a = newToken();
  assert.match(a, /^[a-f0-9]{48}$/);
  assert.notEqual(a, newToken());
});

test("sending stays off until a provider is fully configured", () => {
  assert.equal(sendingEnabled({}), false);
  assert.equal(sendingEnabled({ EMAIL_PROVIDER: "resend" }), false);
  assert.equal(sendingEnabled({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k", MAIL_FROM: "brief@aura.example" }), true);
  assert.equal(sendingEnabled({ EMAIL_PROVIDER: "brevo", MAIL_FROM: "brief@aura.example" }), false);
  assert.equal(sendingEnabled({ EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "k", MAIL_FROM: "brief@aura.example" }), true);
  assert.equal(sendingEnabled({ EMAIL_PROVIDER: "brevo", RESEND_API_KEY: "k", MAIL_FROM: "brief@aura.example" }), false);
  assert.equal(sendingEnabled({ EMAIL_PROVIDER: "gmail", GMAIL_USER: "me@gmail.com" }), false);
  assert.equal(sendingEnabled({ EMAIL_PROVIDER: "gmail", GMAIL_USER: "me@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" }), true);
});

test("confirmation mail links to confirm and to leave", () => {
  const m = confirmationMail("https://auranews.pages.dev", "a@b.com", "f".repeat(48));
  assert.ok(m.html.includes("/api/confirm?token="));
  assert.ok(m.text.includes("/api/unsubscribe?token="));
});

test("Function pages and JSON carry the security headers", () => {
  for (const res of [page("t", "m"), json({ ok: true }), json({ error: "x" }, 405, { Allow: "POST" })]) {
    const h = res.headers;
    assert.equal(h.get("Content-Security-Policy"), "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    assert.match(h.get("Strict-Transport-Security") ?? "", /^max-age=\d{8,}/);
    assert.equal(h.get("X-Content-Type-Options"), "nosniff");
    assert.equal(h.get("Referrer-Policy"), "no-referrer");
    assert.equal(h.get("Cache-Control"), "no-store");
  }
  assert.equal(json({}, 405, { Allow: "POST" }).headers.get("Allow"), "POST");
});
