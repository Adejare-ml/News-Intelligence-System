/**
 * GET  /api/preferences?token=...  A reader's own choices, as a small form.
 * POST /api/preferences?token=...  Saves them.
 *
 * The token in every Morning Brief is the only key: no login, no address
 * shown. Readers choose kinds of news, the region for headline sections,
 * daily or weekly, and can pause without unsubscribing.
 */
import { escapeHtml, page, readBody, validToken, type Ctx } from "../_lib/http.ts";
import {
  CATEGORIES, FREQUENCIES, REGIONS, describePrefs, parsePrefs, type Prefs,
} from "../_lib/categories.ts";
import { subscriberStore, type Subscriber } from "../_lib/subscribers.ts";

const NOT_FOUND = ["Link not recognised", "This link is invalid or has expired. Sign up again on the AURA site any time."] as const;

/** The preferences form, pre-filled. Pure, so it can be tested. */
export function preferencesForm(token: string, prefs: Prefs, paused: boolean): string {
  const checked = (on: boolean) => (on ? " checked" : "");
  const t = escapeHtml(token);
  const topics = CATEGORIES.map(
    (c) => `<label><input type="checkbox" name="categories" value="${c.id}"${checked(prefs.categories.includes(c.id))}> <span>${escapeHtml(c.label)} <span class="hint">${escapeHtml(c.blurb)}</span></span></label>`,
  ).join("");
  const regions = REGIONS.map(
    (r) => `<label><input type="radio" name="region" value="${r.id}"${checked(prefs.region === r.id)}> ${escapeHtml(r.label)}</label>`,
  ).join("");
  const often = FREQUENCIES.map(
    (f) => `<label><input type="radio" name="frequency" value="${f.id}"${checked(prefs.frequency === f.id)}> ${escapeHtml(f.label)} <span class="hint">${escapeHtml(f.when)}</span></label>`,
  ).join("");
  return `<form method="post" action="/api/preferences?token=${t}">
<fieldset><legend>What you want to hear about</legend>${topics}</fieldset>
<fieldset><legend>Headlines from</legend>${regions}<p class="hint">Applies to Sports, Technology, Politics and Entertainment. Business is always Nigeria.</p></fieldset>
<fieldset><legend>How often</legend>${often}</fieldset>
<fieldset><legend>Pause</legend><label><input type="checkbox" name="paused" value="1"${checked(paused)}> Pause the brief for now</label></fieldset>
<button type="submit">Save my choices</button>
</form>
<p class="hint">Want to stop for good? <a href="/api/unsubscribe?token=${t}">Unsubscribe</a>.</p>`;
}

async function load({ request, env }: Ctx): Promise<{ token: string; row: Subscriber } | Response> {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!validToken(token) || !env.DB) return page(NOT_FOUND[0], NOT_FOUND[1], 400);
  const row = await subscriberStore(env.DB).byToken(token);
  if (!row) return page(NOT_FOUND[0], NOT_FOUND[1], 404);
  if (row.status === "unsubscribed") {
    return page("You’re unsubscribed.", "This address no longer receives the Morning Brief. Sign up again on the AURA site any time.");
  }
  return { token, row };
}

export async function onRequestGet(ctx: Ctx): Promise<Response> {
  const found = await load(ctx);
  if (found instanceof Response) return found;
  const { token, row } = found;
  const now = row.paused ? "Paused." : `Right now you get: ${describePrefs(row)}.`;
  return page("Your Morning Brief", now, 200, preferencesForm(token, row, row.paused));
}

export async function onRequestPost(ctx: Ctx): Promise<Response> {
  const found = await load(ctx);
  if (found instanceof Response) return found;
  const { token, row } = found;
  const body = await readBody(ctx.request);
  if (!body) return page("Something went wrong", "We couldn’t read that form. Please try again.", 400, preferencesForm(token, row, row.paused));

  // An unticked form sends no categories at all: that is a mistake here, not "use the default".
  if (body.categories === undefined) body.categories = "none";
  const parsed = parsePrefs(body);
  const paused = String(body.paused ?? "") === "1";
  if ("error" in parsed) return page("Nearly there", parsed.error, 400, preferencesForm(token, row, paused));

  await subscriberStore(ctx.env.DB!).updatePrefs(token, parsed.prefs, paused);
  const message = paused
    ? "Your brief is paused. Come back to this page to start it again."
    : `Saved. You’ll get: ${describePrefs(parsed.prefs)}.`;
  return page("Saved.", message, 200, preferencesForm(token, parsed.prefs, paused));
}
