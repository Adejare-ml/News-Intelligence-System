/**
 * POST /api/follow  { email, slug, company_site }
 *
 * The "Get updates by email" form on company pages. It never adds a follow
 * itself, because anyone can type anyone's address: a confirmed subscriber
 * gets an email with their own one-click confirm link (/api/follow-confirm),
 * and any other address gets an invitation to subscribe. Every valid request
 * gets the same answer, so the form cannot be used to learn who subscribes.
 *
 * Limits, so the form cannot flood an inbox or use up the provider's daily
 * quota before the Morning Brief goes: an address gets at most one such
 * email every ten minutes and three per Lagos day (an address with a row on
 * the list shares its allowance with the sign-up mails; any other address is
 * counted by a hash of it, never the address itself). Past that the post is
 * answered as usual, but nothing is sent. One IP (CF-Connecting-IP) may post
 * 20 times per Lagos day, sign-ups and follows together.
 */
import { json, lagosDay, page, readBody, sha256hex, validEmail, type Ctx } from "../_lib/http.ts";
import { send, sendingEnabled } from "../_lib/mailer.ts";
import { followRequests, loadFollowable } from "../_lib/follows.ts";
import { followConfirmMail, followInviteMail } from "../_lib/follow-mail.ts";
import { MAILS_PER_DAY, subscriberStore, throttle } from "../_lib/subscribers.ts";
import { SIGNUPS_PER_IP_PER_DAY } from "./subscribe.ts";

const answer = (company: string) => `Check your inbox: we’ve sent that address an email about following ${company}.`;

/**
 * The page's script posts JSON and reads JSON back. Without JavaScript the
 * browser posts the plain form and shows whatever comes back, so it gets a
 * readable page instead of a raw JSON body.
 */
function replier(request: Request) {
  const wantsJson = /application\/json/.test(`${request.headers.get("Accept")} ${request.headers.get("Content-Type")}`);
  return {
    ok: (message?: string) => (wantsJson ? json(message ? { ok: true, message } : { ok: true }) : page("Check your inbox", message ?? "Thank you.")),
    fail: (error: string, status: number) => (wantsJson ? json({ error }, status) : page("Something’s not right", error, status)),
  };
}

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  const reply = replier(request);
  const now = new Date();
  const day = lagosDay(now);
  // The sign-up form's budget, shared: a script cannot get 20 mails out of
  // each form, and it is stopped before anything is sent.
  const ip = request.headers.get("CF-Connecting-IP");
  if (env.DB && ip && (await throttle(env.DB).hit(`ip:${ip}`, day)) > SIGNUPS_PER_IP_PER_DAY) {
    return reply.fail("Too many requests from here today. Try again tomorrow.", 429);
  }

  const body = await readBody(request);
  if (!body) return reply.fail("Could not read the form.", 400);

  // Honeypot: a filled hidden field means a bot. Answer as if it worked.
  if (String(body.company_site ?? "").trim()) return reply.ok();

  const email = validEmail(body.email);
  if (!email) return reply.fail("That email address doesn’t look right.", 400);

  const origin = new URL(request.url).origin;
  const slug = String(body.slug ?? "");
  const company = (await loadFollowable(env, origin)).get(slug);
  if (!company) return reply.fail("Updates by email aren’t available for this page.", 400);

  if (!env.DB || !sendingEnabled(env)) return reply.fail("Updates by email open very soon.", 503);

  // Over a limit: the same answer as a sent mail, so the response never
  // tells anyone how often an address has been tried, or whether it subscribes.
  if (!(await followRequests(env.DB).allow(email, now))) return reply.ok(answer(company));
  const store = subscriberStore(env.DB);
  const reader = await store.byEmail(email);
  if (reader) {
    if (!(await store.claimMail(email, now.toISOString(), day))) return reply.ok(answer(company));
  } else if ((await throttle(env.DB).hit(`follow:${await sha256hex(email)}`, day)) > MAILS_PER_DAY) {
    return reply.ok(answer(company));
  }

  const site = env.SITE_URL || origin;
  const sent = await send(env, reader?.status === "confirmed" ? followConfirmMail(site, email, reader.token, slug, company) : followInviteMail(site, email, company));
  if (!sent && reader) await store.releaseMail(email, now.toISOString(), day);
  return reply.ok(answer(company));
}

export function onRequest(): Response {
  return json({ error: "Use POST." }, 405, { Allow: "POST" });
}
