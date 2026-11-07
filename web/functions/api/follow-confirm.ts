/**
 * GET  /api/follow-confirm?token=...&slug=...  A page with one button.
 * POST /api/follow-confirm?token=...&slug=...  Adds the follow.
 *
 * The link comes from the email /api/follow sends a confirmed reader. GET
 * only shows the button, so a mail scanner opening the link changes nothing.
 */
import { escapeHtml, page, validToken, type Ctx } from "../_lib/http.ts";
import { followStore, loadFollowable, MAX_FOLLOWS } from "../_lib/follows.ts";
import { preferencesUrl } from "../_lib/mailer.ts";
import { subscriberStore } from "../_lib/subscribers.ts";

const NOT_FOUND = ["Link not recognised", "This follow link is invalid or has expired. Ask again from the company’s page on AURA."] as const;

async function load({ request, env }: Ctx): Promise<{ token: string; slug: string; company: string } | Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  const slug = url.searchParams.get("slug") || "";
  if (!validToken(token) || !env.DB) return page(NOT_FOUND[0], NOT_FOUND[1], 400);
  const reader = await subscriberStore(env.DB).byToken(token);
  const company = (await loadFollowable(env, url.origin)).get(slug);
  if (reader?.status !== "confirmed" || !company) return page(NOT_FOUND[0], NOT_FOUND[1], 404);
  return { token, slug, company };
}

const manageLink = (token: string) => `<p><a href="${escapeHtml(preferencesUrl("", token))}">See everything you follow</a></p>`;

export async function onRequestGet(ctx: Ctx): Promise<Response> {
  const found = await load(ctx);
  if (found instanceof Response) return found;
  const { token, slug, company } = found;
  const action = escapeHtml(`/api/follow-confirm?token=${token}&slug=${encodeURIComponent(slug)}`);
  return page(
    `Follow ${company}?`,
    `New reporting on ${company} will appear in a “Following” section of your Morning Brief.`,
    200,
    `<form method="post" action="${action}"><button type="submit">Follow ${escapeHtml(company)}</button></form>`,
  );
}

export async function onRequestPost(ctx: Ctx): Promise<Response> {
  const found = await load(ctx);
  if (found instanceof Response) return found;
  const { token, slug, company } = found;
  const result = await followStore(ctx.env.DB!).add(token, slug, new Date().toISOString());
  if (result === "full") {
    return page(
      "Your list is full.",
      `You already follow ${MAX_FOLLOWS} companies, the most one brief can carry. Unfollow one to make room for ${company}.`,
      409,
      manageLink(token),
    );
  }
  const message = result === "added"
    ? `You now follow ${company}. It appears in your Morning Brief whenever there is new reporting on it.`
    : `You already follow ${company}.`;
  return page("Done.", message, 200, manageLink(token));
}
