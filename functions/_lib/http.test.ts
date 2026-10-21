import { test } from "node:test";
import assert from "node:assert/strict";
import { validEmail, newToken } from "./http.ts";
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
});

test("confirmation mail links to confirm and to leave", () => {
  const m = confirmationMail("https://auranews.pages.dev", "a@b.com", "f".repeat(48));
  assert.ok(m.html.includes("/api/confirm?token="));
  assert.ok(m.text.includes("/api/unsubscribe?token="));
});
