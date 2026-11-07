/**
 * POST /api/send-brief   Authorization: Bearer <BRIEF_SEND_SECRET>
 *
 * Emails today's Morning Brief to every confirmed, unpaused subscriber who
 * is due (daily readers every day, weekly readers on Mondays, Lagos time).
 * Called by the scheduler after the 08:00 Lagos run has been published, so
 * what it sends is what the site shows. Subscriber addresses never leave
 * Cloudflare: GitHub only holds the secret that triggers this.
 *
 * Each reader gets one email with the kinds of news they chose. Readers
 * with the same choices share a copy, so each distinct email is built once:
 *   - Business readers: the brief page (/brief/email/);
 *   - everyone else: the shell page (/brief/email/shell/);
 *   - then each chosen headline category (/brief/email/section/<id>/) goes
 *     in at the sections slot, with only the regions the reader chose; a
 *     category with no headlines in those regions is left out;
 *   - weekly Business readers get the week in business (the Sunday weekly
 *     wrap, /brief/email/section/business-week/) on Mondays instead of the
 *     daily brief, while the wrap is fresh;
 *   - readers who follow companies get a "Following" block after their
 *     sections, built from /brief/email/follow/<slug>/ for each followed
 *     company with new reporting. Readers whose follows have nothing new
 *     share the email of readers who follow nothing.
 *
 *   ?dry_run=1  report the edition, subject and recipient counts; send nothing
 *   ?test=1     send one copy to OWNER_EMAIL; record nothing. Add
 *               &categories=business,sports&region=both to preview a mix.
 *
 * Safe to call twice: one send per Lagos day. A business edition that was
 * already sent (the pipeline produced nothing new) is not sent again; readers
 * who also chose headline categories still get those.
 */
import { authorised, escapeHtml, json, type Ctx, type Env } from "../_lib/http.ts";
import { decodeEntities, htmlToText, preferencesUrl, sendBrief, sendBriefs, sendingEnabled, unsubscribeUrl } from "../_lib/mailer.ts";
import {
  categoryLabel, comboKey, editionsFor, headlineCategories, listLabels, parseCategories, parseRegion,
  type Edition, type HeadlineCategory, type Prefs,
} from "../_lib/categories.ts";
import { sendLog, subscriberStore, type Subscriber } from "../_lib/subscribers.ts";
import { followStore, loadFollowable } from "../_lib/follows.ts";

// Kept as exports here: older tests and scripts import them from this module.
export { sameSecret, authorised } from "../_lib/http.ts";

export const SECTIONS_SLOT = "<!--aura:sections-->";
/** Headlines older than this are left out rather than sent as news. */
export const MAX_HEADLINE_AGE_HOURS = 36;
/** The weekly wrap is built Sunday evening; on Monday morning it is about half a day old. */
export const MAX_WRAP_AGE_HOURS = 48;

export function lagosDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function lagosWeekday(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", weekday: "short" }).format(now);
}

/** Daily readers every day; weekly readers on Mondays (Lagos time). */
export function isDue(frequency: Prefs["frequency"], now: Date): boolean {
  return frequency === "daily" || lagosWeekday(now) === "Mon";
}

export function readMeta(html: string, name: string): string {
  const m = html.match(new RegExp(`<meta[^>]+name="${name}"[^>]+content="([^"]*)"`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

/**
 * The site adds its prefetch script to every page, the email page too. Mail
 * clients never run it, and some flag scripts, so each <script> element is
 * cut out (repeatedly, until none is left) before sending.
 */
export function stripScripts(html: string): string {
  let out = html;
  for (;;) {
    const lower = out.toLowerCase();
    const start = lower.indexOf("<script");
    if (start === -1) return out;
    const close = lower.indexOf("</script>", start);
    const end = close === -1 ? out.length : close + "</script>".length;
    out = out.slice(0, start) + out.slice(end);
  }
}

/** The rows between <!--aura:section--> and <!--/aura:section-->, or "" when the page has none. */
export function extractSection(html: string): string {
  const start = html.indexOf("<!--aura:section-->");
  const end = html.indexOf("<!--/aura:section-->");
  if (start === -1 || end === -1 || end < start) return "";
  return html.slice(start + "<!--aura:section-->".length, end).trim();
}

/** True when at least one of the kept regions has headlines (empty ones carry <!--empty-->). */
export function hasHeadlines(section: string, keep: Edition[]): boolean {
  const blocks = [...section.matchAll(/<!--region:(\w+)-->([\s\S]*?)<!--\/region:\1-->/g)];
  if (!blocks.length) return section.trim() !== "";
  return blocks.some(([, region, body]) => keep.includes(region as Edition) && !body.includes("<!--empty-->"));
}

/** Drops the region blocks the reader did not choose. */
export function filterRegions(section: string, keep: Edition[]): string {
  return section.replace(/<!--region:(\w+)-->([\s\S]*?)<!--\/region:\1-->/g, (_m, region: string, body: string) =>
    keep.includes(region as Edition) ? body : "",
  );
}

/**
 * Puts the sections in at the slot. With sections to add, a base without a
 * slot is a build error, not something to guess around.
 */
export function composeEmail(base: string, sections: string[]): string {
  if (!sections.length) return base.replace(SECTIONS_SLOT, "");
  if (!base.includes(SECTIONS_SLOT)) throw new Error("The email template has no sections slot.");
  // A replacer function, so "$&" or "$'" in a headline is never read as a pattern.
  return base.replace(SECTIONS_SLOT, () => sections.join("\n"));
}

/** Replaces the text between <!--aura:NAME--> and <!--/aura:NAME--> (escaped by the caller). */
export function replaceMarked(html: string, name: string, text: string): string {
  const start = `<!--aura:${name}-->`;
  const end = `<!--/aura:${name}-->`;
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a === -1 || b === -1 || b < a) return html;
  return html.slice(0, a + start.length) + text + html.slice(b);
}

const WEEK_INTRO = "The week in business from AURA’s own records";
const WEEK_SOURCE = "The week in business is compiled automatically from AURA’s pipeline records; ownership items are press reports, not CAC records.";
const HEADLINE_SOURCE = "Headlines are collected automatically from Google News; each links to the outlet that published it.";

export interface Group {
  key: string;
  prefs: Prefs;
  readers: Subscriber[];
  /** Followed companies in this group's email: with new reporting, and listed by name only. */
  follow?: { news: string[]; more: string[] };
}

/** Fragment fetches per send, so a long tail of follows cannot exhaust a Function's subrequests. */
export const MAX_FOLLOW_FETCHES = 30;

/** Today's follow material, fetched once per send. */
export interface Following {
  /** slug -> rows, for companies with fresh, non-empty reporting. */
  fragments: Map<string, string>;
  /** slug -> name, for followed companies past the fetch cap: listed as links, not checked. */
  unfetched: Map<string, string>;
  /** Fragments requested, for the send report. */
  fetched: number;
}

/** A short, stable label for a list of follows (FNV-1a), so reports never name what a reader follows. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Weekly Business readers get different content (the week in business), so they group apart. */
export function groupKey(prefs: Prefs): string {
  const weeklyBusiness = prefs.frequency === "weekly" && prefs.categories.includes("business");
  return comboKey(prefs) + (weeklyBusiness ? "|weekly" : "");
}

/**
 * Readers with the same choices share one email. Follows split a group only
 * when they put something in the email (news today, or a name past the
 * fetch cap); the full list keys the group, the reported key carries a hash.
 */
export function groupRecipients(readers: Subscriber[], follows = new Map<string, string[]>(), following?: Following): Group[] {
  const groups = new Map<string, Group>();
  for (const r of readers) {
    const mine = follows.get(r.token) ?? [];
    const news = following ? mine.filter((s) => following.fragments.has(s)) : [];
    const more = following ? mine.filter((s) => following.unfetched.has(s)) : [];
    const sig = news.length || more.length ? `${news.join(",")}|${more.join(",")}` : "";
    const id = sig ? `${groupKey(r)}|${sig}` : groupKey(r);
    const g = groups.get(id) ?? {
      key: sig ? `${groupKey(r)}|follow:${shortHash(sig)}` : groupKey(r),
      prefs: { categories: r.categories, region: r.region, frequency: r.frequency },
      readers: [],
      ...(sig ? { follow: { news, more } } : {}),
    };
    g.readers.push(r);
    groups.set(id, g);
  }
  return [...groups.values()];
}

/** Followed companies of the due readers, most followed first, so the fetch cap keeps the most-read ones. */
export function rankFollows(readers: Subscriber[], follows: Map<string, string[]>): string[] {
  const count = new Map<string, number>();
  for (const r of readers) for (const s of follows.get(r.token) ?? []) count.set(s, (count.get(s) ?? 0) + 1);
  return [...count.keys()].sort((a, b) => count.get(b)! - count.get(a)! || a.localeCompare(b));
}

// Inline styles matching the category sections (web/src/components/email/theme.ts),
// repeated here because the Functions bundle cannot import from web/src.
const FOLLOW_LABEL = "padding:22px 32px 6px;font:700 11px/1.4 Helvetica,Arial,sans-serif;letter-spacing:2px;text-transform:uppercase;color:#9c7420;border-top:1px solid #e7e0cf;";
const FOLLOW_MORE = "padding:6px 32px 10px;font:13px/1.5 Helvetica,Arial,sans-serif;color:#6b6558;";

/** The reader's Following block: each company's rows, then any followed names not checked today. */
export function followingBlock(rows: string[], more: { slug: string; name: string }[], site: string): string {
  if (!rows.length && !more.length) return "";
  const links = more
    .map((c) => `<a href="${escapeHtml(`${site}/entity/${c.slug}/`)}" style="color:#1e3fae;text-decoration:none;">${escapeHtml(c.name)}</a>`)
    .join(" · ");
  const tail = more.length ? `<tr><td style="${FOLLOW_MORE}">Also following (see their pages for the latest): ${links}</td></tr>` : "";
  return `<tr><td style="${FOLLOW_LABEL}">Following</td></tr>\n${rows.join("\n")}${tail}`;
}


export function hoursOld(generated: string, now: Date): number {
  // The pipeline stamps local runner time (UTC on GitHub Actions) as "YYYY-MM-DD HH:MM:SS".
  const t = Date.parse(generated.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(generated) ? "" : "Z"));
  return Number.isNaN(t) ? Infinity : (now.getTime() - t) / 3_600_000;
}

/** Everything the sender needs, fetched once per run from the site's own pages. */
export interface Templates {
  business: { html: string; edition: string; subject: string } | null;
  shell: { html: string; subject: string };
  sections: Partial<Record<HeadlineCategory, string>>;
  /** The week in business, when the weekly wrap is fresh. */
  week?: { rows: string; label: string } | null;
}

async function fetchPage(env: Env, origin: string, path: string): Promise<string | null> {
  const res = await env.ASSETS!.fetch(new Request(new URL(path, origin)));
  return res.ok ? stripScripts(await res.text()) : null;
}

/** Fetches up to MAX_FOLLOW_FETCHES fragments, in `ranked` order; followed companies without a page are dropped. */
export async function loadFollowing(env: Env, origin: string, ranked: string[], followable: Map<string, string>, now: Date): Promise<Following> {
  const following: Following = { fragments: new Map(), unfetched: new Map(), fetched: 0 };
  for (const slug of ranked.filter((s) => followable.has(s))) {
    if (following.fetched >= MAX_FOLLOW_FETCHES) {
      following.unfetched.set(slug, followable.get(slug)!);
      continue;
    }
    following.fetched++;
    const html = await fetchPage(env, origin, `/brief/email/follow/${slug}/`);
    if (!html || hoursOld(readMeta(html, "aura-generated"), now) > MAX_HEADLINE_AGE_HOURS) continue;
    const rows = extractSection(html);
    if (rows && !rows.includes("<!--empty-->")) following.fragments.set(slug, rows);
  }
  return following;
}

export async function loadTemplates(env: Env, origin: string, wanted: HeadlineCategory[], now: Date, withWeek = false): Promise<Templates | string> {
  const businessHtml = await fetchPage(env, origin, "/brief/email/");
  if (!businessHtml) return "The email template page is missing.";
  const edition = readMeta(businessHtml, "aura-edition");
  if (!edition) return "The template does not name its edition.";
  const shellHtml = await fetchPage(env, origin, "/brief/email/shell/");
  if (!shellHtml) return "The email shell page is missing.";

  const sections: Templates["sections"] = {};
  for (const category of wanted) {
    const html = await fetchPage(env, origin, `/brief/email/section/${category}/`);
    if (!html) continue;
    if (hoursOld(readMeta(html, "aura-generated"), now) > MAX_HEADLINE_AGE_HOURS) continue;
    const rows = extractSection(html);
    if (rows) sections[category] = rows;
  }
  let week: Templates["week"] = null;
  if (withWeek) {
    const html = await fetchPage(env, origin, "/brief/email/section/business-week/");
    const rows = html ? extractSection(html) : "";
    if (html && rows && hoursOld(readMeta(html, "aura-generated"), now) <= MAX_WRAP_AGE_HOURS) {
      week = { rows, label: readMeta(html, "aura-week") };
    }
  }
  return {
    week,
    business: { html: businessHtml, edition, subject: readMeta(businessHtml, "aura-subject") || "AURA Morning Brief" },
    shell: { html: shellHtml, subject: readMeta(shellHtml, "aura-subject") || "AURA Morning Brief" },
    sections,
  };
}

/**
 * One group's email, or null when there is nothing fresh to send them.
 * `businessFresh` is false when today's business edition was already sent.
 */
export function buildFor(
  prefs: Prefs,
  t: Templates,
  businessFresh: boolean,
  following?: { html: string; hasNews: boolean },
): { subject: string; html: string; text: string } | null {
  const editions = editionsFor(prefs.region);
  const chosen = headlineCategories(prefs).filter((c) => t.sections[c] && hasHeadlines(t.sections[c]!, editions));
  const sections = chosen.map((c) => filterRegions(t.sections[c]!, editions));
  const wantsBusiness = prefs.categories.includes("business");
  // Weekly Business readers get the week in business when the wrap is fresh,
  // else that Monday's brief like everyone else.
  const week = wantsBusiness && prefs.frequency === "weekly" && t.week ? t.week : null;
  const withBusiness = wantsBusiness && !week && businessFresh && t.business;
  // Names listed past the fetch cap are not news, so they never send an email on their own.
  const followNews = Boolean(following?.hasNews);
  if (!withBusiness && !week && !sections.length && !followNews) return null;
  let base = withBusiness ? t.business!.html : t.shell.html;
  if (week) {
    base = replaceMarked(base, "intro", sections.length ? `${WEEK_INTRO}, then the headlines you chose.` : `${WEEK_INTRO}.`);
    base = replaceMarked(base, "source", sections.length ? `${WEEK_SOURCE} ${HEADLINE_SOURCE}` : WEEK_SOURCE);
  }
  const follow = following?.html ? [following.html] : [];
  const html = composeEmail(base, [...(week ? [week.rows] : []), ...sections, ...follow]);
  const labels = [...(week ? ["The week in business"] : []), ...chosen.map(categoryLabel), ...(followNews ? ["Following"] : [])];
  const subject = withBusiness ? t.business!.subject : `${t.shell.subject} · ${listLabels(labels)}`;
  return { subject, html, text: htmlToText(html) };
}

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  if (!env.BRIEF_SEND_SECRET) return json({ error: "Sending is not configured (BRIEF_SEND_SECRET)." }, 503);
  if (!authorised(request, env)) return json({ error: "Not authorised." }, 401);

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const test = url.searchParams.get("test") === "1";
  if (!env.DB) return json({ error: "Subscriber database (DB) is not bound." }, 503);
  if (!dryRun && !sendingEnabled(env)) return json({ error: "Email provider is not configured." }, 503);
  if (!env.ASSETS) return json({ error: "Static assets are unavailable." }, 503);

  const now = new Date();
  const site = (env.SITE_URL || url.origin).replace(/\/$/, "");
  const day = lagosDay(now);

  if (test) {
    if (!env.OWNER_EMAIL) return json({ error: "Set OWNER_EMAIL to receive a test copy." }, 400);
    const categories = parseCategories(url.searchParams.get("categories") ?? "business");
    const prefs: Prefs = {
      categories: categories.length ? categories : ["business"],
      region: parseRegion(url.searchParams.get("region")) ?? "nigeria",
      frequency: url.searchParams.get("frequency") === "weekly" ? "weekly" : "daily",
    };
    const t = await loadTemplates(env, url.origin, headlineCategories(prefs), now, prefs.frequency === "weekly");
    if (typeof t === "string") return json({ error: t }, 500);
    const mail = buildFor(prefs, t, true);
    if (!mail) return json({ error: "Nothing to send for that mix: no fresh headlines." }, 409);
    const result = await sendBrief(env, mail, [{ to: env.OWNER_EMAIL, unsubscribe: `${site}/api/unsubscribe`, preferences: `${site}/api/preferences` }]);
    return json({ test: true, edition: t.business?.edition, subject: mail.subject, prefs, ...result });
  }

  const log = sendLog(env.DB);
  const today = await log.forDay(day);
  if (today?.finished_at) return json({ skipped: "already_sent_today", day, edition: today.edition });
  if (today) return json({ skipped: "send_in_progress_or_incomplete", day }, 409);

  const due = (await subscriberStore(env.DB).recipients()).filter((r) => isDue(r.frequency, now));
  // Follows are an extra: if they cannot be read (migration 0007 not applied
  // yet), the brief still goes out without a Following block, and the report says why.
  let follows = new Map<string, string[]>();
  let followError = "";
  try {
    follows = await followStore(env.DB).forRecipients();
  } catch (err) {
    followError = `follows not read: ${(err as Error).message}`;
  }
  const ranked = rankFollows(due, follows);
  const following = ranked.length
    ? await loadFollowing(env, url.origin, ranked, await loadFollowable(env, url.origin), now)
    : { fragments: new Map<string, string>(), unfetched: new Map<string, string>(), fetched: 0 };
  const groups = groupRecipients(due, follows, following);
  const wanted = [...new Set(groups.flatMap((g) => headlineCategories(g.prefs)))];
  const weekly = groups.some((g) => groupKey(g.prefs).endsWith("|weekly"));
  const t = await loadTemplates(env, url.origin, wanted, now, weekly);
  if (typeof t === "string") return json({ error: t }, 500);
  const edition = t.business!.edition;
  const sentOn = await log.sentOn(edition);
  const businessFresh = !sentOn;

  const followFor = (g: Group) =>
    g.follow && {
      html: followingBlock(
        g.follow.news.map((s) => following.fragments.get(s)!),
        g.follow.more.map((slug) => ({ slug, name: following.unfetched.get(slug)! })),
        site,
      ),
      hasNews: g.follow.news.length > 0,
    };
  const plan = groups.map((g) => ({ group: g, mail: buildFor(g.prefs, t, businessFresh, followFor(g)) }));
  const sending = plan.filter((p) => p.mail);
  const recipients = sending.reduce((n, p) => n + p.group.readers.length, 0);
  const summary = {
    day,
    edition,
    business_fresh: businessFresh,
    headline_sections: Object.keys(t.sections),
    week_in_business: Boolean(t.week),
    // Counts and public company slugs only: never who follows what.
    following: {
      followed: ranked.length,
      fetched: following.fetched,
      with_news: [...following.fragments.keys()],
      listed_only: following.unfetched.size,
      ...(followError ? { error: followError } : {}),
    },
    recipients,
    skipped_readers: due.length - recipients,
    groups: plan.map((p) => ({ mix: p.group.key, readers: p.group.readers.length, subject: p.mail?.subject ?? null })),
  };

  if (dryRun) return json({ dry_run: true, subject: t.business!.subject, ...summary });
  if (!recipients) {
    return json(sentOn ? { skipped: "edition_already_sent", edition, sent_on: sentOn } : { skipped: "nothing_to_send", ...summary });
  }

  await log.start(day, edition, now.toISOString());
  // Every group in one pass: one Gmail session under one daily cap, and
  // shared provider batches however many distinct mixes there are.
  const result = await sendBriefs(
    env,
    sending.map(({ group, mail }) => ({
      brief: mail!,
      recipients: group.readers.map((r) => ({ to: r.email, unsubscribe: unsubscribeUrl(site, r.token), preferences: preferencesUrl(site, r.token) })),
    })),
  );
  const { sent, failed } = result;
  await log.finish(day, sent, failed, new Date().toISOString());

  const body = { ...summary, sent, failed, ...(result.error ? { error: result.error } : {}) };
  return json(body, failed && !sent ? 502 : 200);
}

export function onRequest(): Response {
  return json({ error: "Use POST." }, 405, { Allow: "POST" });
}
