/**
 * The two emails the site's "Get updates by email" form can send. Which one
 * goes out depends on whether the address is a confirmed subscriber, but the
 * form's response is the same either way, so the form never reveals who is
 * on the list: only the address's owner learns that, from their inbox.
 */
import { escapeHtml } from "./http.ts";
import type { Mail } from "./mailer.ts";

const layout = (heading: string, body: string, button: string, href: string, footer: string) =>
  `<div style="font-family:Georgia,serif;max-width:520px;margin:auto;padding:24px;color:#1b1a17">
<p style="letter-spacing:.14em;font:600 12px system-ui;color:#9c7420">AURA · MORNING BRIEF</p>
<h1 style="font-weight:500">${heading}</h1>
<p style="font:16px/1.6 system-ui">${body}</p>
<p><a href="${href.replace(/&/g, "&amp;")}" style="display:inline-block;background:#1e3fae;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font:600 15px system-ui">${button}</a></p>
<p style="font:13px/1.6 system-ui;color:#6b6558">${footer}</p></div>`;

export function followConfirmUrl(site: string, token: string, slug: string): string {
  return `${site.replace(/\/$/, "")}/api/follow-confirm?token=${token}&slug=${encodeURIComponent(slug)}`;
}

/** For a confirmed reader: their own one-click link, since anyone can type anyone's address into the form. */
export function followConfirmMail(site: string, email: string, token: string, slug: string, company: string): Mail {
  const link = followConfirmUrl(site, token, slug);
  const name = escapeHtml(company);
  return {
    to: email,
    subject: `Follow ${company} in your AURA Morning Brief?`,
    text: `Someone (probably you) asked for updates about ${company} on AURA. Confirm, and new reporting on ${company} appears in a "Following" section of your Morning Brief:\n${link}\n\nDidn't ask? Ignore this email and nothing changes.`,
    html: layout(
      "One click to follow.",
      `Someone (probably you) asked for updates about <strong>${name}</strong> on AURA. Confirm, and new reporting on ${name} appears in a “Following” section of your Morning Brief.`,
      `Follow ${name}`,
      link,
      "Didn't ask? Ignore this email and nothing changes.",
    ),
  };
}

/** For any other address: how to get updates, without saying whether it was ever on the list. */
export function followInviteMail(site: string, email: string, company: string): Mail {
  const join = `${site.replace(/\/$/, "")}/brief/#subscribe`;
  const name = escapeHtml(company);
  return {
    to: email,
    subject: `Updates about ${company} come with the AURA Morning Brief`,
    text: `Someone (probably you) asked for updates about ${company} on AURA. Updates arrive in the AURA Morning Brief, which this address doesn't receive. Subscribe here, then ask again from the ${company} page:\n${join}\n\nDidn't ask? Ignore this email and nothing changes.`,
    html: layout(
      `Updates on ${name}`,
      `Someone (probably you) asked for updates about <strong>${name}</strong> on AURA. Updates arrive in the AURA Morning Brief, which this address doesn't receive. Subscribe, then ask again from the ${name} page.`,
      "Get the Morning Brief",
      join,
      "Didn't ask? Ignore this email and nothing changes.",
    ),
  };
}
