import { test } from "node:test";
import assert from "node:assert/strict";
import { compileMessage, qpEncode, smtpSend, encodeHeader } from "./smtp.ts";
import { fakeSmtp } from "./smtp-fake.test.ts";

/** Decodes quoted-printable back to text, to check what a mail client would show. */
function qpDecode(s: string): string {
  const bytes: number[] = [];
  const flat = s.replace(/=\r\n/g, "");
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] === "=" && /^[0-9A-F]{2}$/.test(flat.slice(i + 1, i + 3))) {
      bytes.push(parseInt(flat.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...new TextEncoder().encode(flat[i]));
  }
  return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\r\n/g, "\n");
}

const login = { user: "aura.owner@gmail.com", password: "app-password" };
const from = "AURA Morning Brief <aura.owner@gmail.com>";

test("qpEncode: short lines, no raw dots or non-ASCII, and it round-trips", () => {
  const src = `.starts with a dot\n${"x".repeat(200)}\nNaira ₦ and Lagos · Abuja = fine \n`;
  const q = qpEncode(src);
  for (const line of q.split("\r\n")) {
    assert.ok(line.length <= 76, `line too long: ${line.length}`);
    assert.ok(!line.startsWith("."), "a line starting with a dot would end DATA early");
    assert.ok(/^[\x20-\x7e]*$/.test(line), "only printable ASCII on the wire");
  }
  assert.equal(qpDecode(q), src);
});

test("encodeHeader leaves ASCII alone and encodes the rest", () => {
  assert.equal(encodeHeader("Morning Brief"), "Morning Brief");
  assert.match(encodeHeader("AURA Morning Brief · Thursday"), /^=\?UTF-8\?B\?.+\?=$/);
});

test("one session sends every copy, each with only its own unsubscribe link", async () => {
  const server = fakeSmtp();
  const build = compileMessage({
    from,
    subject: "AURA Morning Brief · Thursday 22 October",
    html: '<p>Hello &amp; welcome</p><a href="{{unsubscribe_url}}">Unsubscribe</a>',
    text: "Hello & welcome\nUnsubscribe ({{unsubscribe_url}})",
  });
  const link = (t: string) => `https://auranews.pages.dev/api/unsubscribe?token=${t.repeat(48)}`;
  const result = await smtpSend(server.open, login, [
    { from, to: "a@example.com", data: () => build("a@example.com", link("a")) },
    { from, to: "d@example.com", data: () => build("d@example.com", link("d")) },
  ]);
  assert.deepEqual(result, { sent: 2, failed: 0 });
  assert.equal(server.transcript.filter((l) => l === "AUTH LOGIN").length, 1, "one login for the whole batch");
  assert.deepEqual(server.delivered.map((m) => m.to), ["a@example.com", "d@example.com"]);

  const a = server.delivered[0].data;
  assert.match(a, /^List-Unsubscribe: <https:\/\/auranews\.pages\.dev\/api\/unsubscribe\?token=a{48}>$/m);
  assert.match(a, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  assert.match(a, /^To: <a@example\.com>$/m);
  assert.match(a, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(a, /^Content-Type: multipart\/alternative; boundary="aura-/m);
  const decoded = qpDecode(a);
  assert.ok(decoded.includes(`href="${link("a")}"`), "HTML carries the reader's link");
  assert.ok(decoded.includes(`Unsubscribe (${link("a")})`), "text carries the reader's link");
  assert.ok(!decoded.includes("d".repeat(48)), "no one else's link");
  assert.ok(!a.includes("{{unsubscribe_url}}"));
});

test("a refused recipient is counted and the rest still go out", async () => {
  const server = fakeSmtp({ reject: ["gone@example.com"] });
  const build = compileMessage({ from, subject: "s", html: "<p>h</p>", text: "t" });
  const result = await smtpSend(server.open, login, ["a@example.com", "gone@example.com", "d@example.com"].map((to) => ({ from, to, data: () => build(to) })));
  assert.equal(result.sent, 2);
  assert.equal(result.failed, 1);
  assert.match(result.error ?? "", /No such user/);
  assert.deepEqual(server.delivered.map((m) => m.to), ["a@example.com", "d@example.com"]);
});

test("a wrong app password sends nothing and says why", async () => {
  const server = fakeSmtp({ password: "something-else" });
  const build = compileMessage({ from, subject: "s", html: "<p>h</p>", text: "t" });
  const result = await smtpSend(server.open, login, [{ from, to: "a@example.com", data: () => build("a@example.com") }]);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.match(result.error ?? "", /login: 535/);
  assert.equal(server.delivered.length, 0);
});

test("a connection that cannot open fails cleanly", async () => {
  const result = await smtpSend(async () => { throw new Error("connect refused"); }, login, [
    { from, to: "a@example.com", data: () => "x" },
  ]);
  assert.deepEqual(result, { sent: 0, failed: 1, error: "connect refused" });
});
