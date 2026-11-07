/**
 * GET  /api/preferences?token=...  A reader's own choices, as a small form.
 * POST /api/preferences?token=...  Saves them.
 *
 * The token in every Morning Brief is the only key: no login, no address
 * shown. Readers choose kinds of news, the region for headline sections,
 * daily or weekly, and can pause without unsubscribing. They also manage the
 * companies they follow (posts with follow_action=add|remove), picked from
 * the build-time list of followable companies.
 */
import { escapeHtml, page, readBody, validToken, type Ctx } from "../_lib/http.ts";
import {
  CATEGORIES, FREQUENCIES, REGIONS, describePrefs, parsePrefs, type Prefs,
} from "../_lib/categories.ts";
import { subscriberStore, type Subscriber } from "../_lib/subscribers.ts";
import { followStore, loadFollowable, matchCompany, MAX_FOLLOWS } from "../_lib/follows.ts";

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

/** The page's own form styles make every input a small checkbox; the company field needs a real width. */
const TEXT_INPUT = "width:100%;height:auto;box-sizing:border-box;padding:10px 12px;margin:6px 0 12px;border-radius:8px;border:1px solid #2a2f40;background:#0b0d14;color:#ede6d8;font:inherit";

/** Followed companies with unfollow buttons, and a field to add one. Pure, so it can be tested. */
export function followSection(token: string, follows: string[], followable: Map<string, string>): string {
  const action = `/api/preferences?token=${escapeHtml(token)}#following`;
  const items = follows.map((slug) => `<li><form method="post" action="${action}" style="display:flex;gap:10px;align-items:center;justify-content:space-between;padding:4px 0">
<input type="hidden" name="follow_action" value="remove"><input type="hidden" name="slug" value="${escapeHtml(slug)}">
<span>${escapeHtml(followable.get(slug) ?? slug)}</span><button type="submit" style="padding:6px 14px;font-size:13px">Unfollow</button></form></li>`).join("");
  const list = follows.length
    ? `<ul style="list-style:none;margin:0;padding:0">${items}</ul>`
    : `<p class="hint">You don’t follow any companies yet.</p>`;
  const options = [...followable.values()].map((name) => `<option value="${escapeHtml(name)}">`).join("");
  const add = follows.length >= MAX_FOLLOWS
    ? `<p class="hint">You follow ${MAX_FOLLOWS} companies, the most one brief can carry. Unfollow one to add another.</p>`
    : `<form method="post" action="${action}"><input type="hidden" name="follow_action" value="add">
<label for="follow-company" style="display:block;padding:8px 0 0">Add a company</label>
<input id="follow-company" name="company" list="followable-companies" autocomplete="off" placeholder="Start typing a company name" style="${TEXT_INPUT}">
<datalist id="followable-companies">${options}</datalist>
<button type="submit">Follow</button></form>`;
  return `<fieldset id="following"><legend>Companies you follow</legend>
<p class="hint">New reporting on these appears in a “Following” section of your brief. Companies with a page on AURA only, up to ${MAX_FOLLOWS}.</p>
${list}${add}</fieldset>`;
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
  return page("Your Morning Brief", now, 200, await withFollows(ctx, token, preferencesForm(token, row, row.paused)));
}

/**
 * The preferences form followed by the reader's follows, read fresh after any
 * change. If follows cannot be read (migration 0007 not applied yet), the
 * section is left out so readers can still change their topics.
 */
async function withFollows(ctx: Ctx, token: string, form: string, followable?: Map<string, string>): Promise<string> {
  const list = followable ?? (await loadFollowable(ctx.env, new URL(ctx.request.url).origin));
  try {
    return form + followSection(token, await followStore(ctx.env.DB!).list(token), list);
  } catch {
    return form;
  }
}

/** An add or remove from the follow section; leaves topics and frequency alone. */
async function changeFollow(ctx: Ctx, token: string, row: Subscriber, body: Record<string, unknown>): Promise<Response> {
  const followable = await loadFollowable(ctx.env, new URL(ctx.request.url).origin);
  const store = followStore(ctx.env.DB!);
  const render = async (title: string, message: string, status = 200) =>
    page(title, message, status, await withFollows(ctx, token, preferencesForm(token, row, row.paused), followable));
  if (body.follow_action === "remove") {
    const slug = String(body.slug ?? "");
    await store.remove(token, slug);
    return render("Saved.", `You no longer follow ${followable.get(slug) ?? slug}.`);
  }
  const slug = matchCompany(body.company, followable);
  if (!slug) return render("Nearly there", "We couldn’t find that company. Pick one from the list: companies with a page on AURA.", 400);
  const result = await store.add(token, slug, new Date().toISOString());
  if (result === "full") return render("Your list is full.", `You already follow ${MAX_FOLLOWS} companies. Unfollow one to add another.`, 409);
  return render("Saved.", result === "added" ? `You now follow ${followable.get(slug)}.` : `You already follow ${followable.get(slug)}.`);
}

export async function onRequestPost(ctx: Ctx): Promise<Response> {
  const found = await load(ctx);
  if (found instanceof Response) return found;
  const { token, row } = found;
  const body = await readBody(ctx.request);
  if (!body) return page("Something went wrong", "We couldn’t read that form. Please try again.", 400, preferencesForm(token, row, row.paused));
  if (body.follow_action === "add" || body.follow_action === "remove") return changeFollow(ctx, token, row, body);

  // An unticked form sends no categories at all: that is a mistake here, not "use the default".
  if (body.categories === undefined) body.categories = "none";
  const parsed = parsePrefs(body);
  const paused = String(body.paused ?? "") === "1";
  if ("error" in parsed) return page("Nearly there", parsed.error, 400, await withFollows(ctx, token, preferencesForm(token, row, paused)));

  await subscriberStore(ctx.env.DB!).updatePrefs(token, parsed.prefs, paused);
  const message = paused
    ? "Your brief is paused. Come back to this page to start it again."
    : `Saved. You’ll get: ${describePrefs(parsed.prefs)}.`;
  return page("Saved.", message, 200, await withFollows(ctx, token, preferencesForm(token, parsed.prefs, paused)));
}
