/**
 * The Markdown export of an entity page (/entity/<slug>.md). It holds only
 * what the page shows, in the page's order, so a copied file never says
 * more than AURA publishes. The page's summary line lives here too, so the
 * page and the file cannot drift apart.
 */
import { describeHolding } from "./psc.ts";
import { toStory } from "./stories.ts";
import { slugify } from "./entity-key.ts";
import type { Entity } from "./entities.ts";

export function entitySummary(e: Entity): string {
  const isPerson = e.kind === "person";
  if (!e.holdings.length) return `Mentioned in ${e.mentions ?? e.articles.length} reports tracked by AURA.`;
  if (!isPerson) return `${e.holdings.length} reported ${e.holdings.length === 1 ? "holder" : "holders"} with significant control.`;
  const more = e.holdings.length - 1;
  return `${e.name} ${describeHolding(e.holdings[0])}${more ? `, and is reported in ${more} more ${more === 1 ? "company" : "companies"}` : ""}.`;
}

/** "2026-10-03" -> "3 Oct 2026", the date style the page uses. */
export function formatDay(iso: string): string {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Names come from news text; escape what Markdown would read as formatting or links. */
export function mdText(value: unknown): string {
  return String(value ?? "").replace(/([\\`*_[\]<>#|])/g, "\\$1");
}

// Parentheses and spaces would end a Markdown link target early, so they are percent-encoded.
const linkTarget = (url: string) => url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
const link = (label: string, url: string) => `[${mdText(label)}](${linkTarget(url)})`;

export function entityMarkdown(e: Entity, opts: { pageUrl: string; entityUrl: (slug: string) => string }): string {
  const isPerson = e.kind === "person";
  const out: string[] = [`# ${mdText(e.name)}`, "", `${isPerson ? "Person or holder" : "Company or body"}${e.industry ? ` · ${mdText(e.industry)}` : ""}`, "", mdText(entitySummary(e)), ""];

  const facts = [
    e.mentions !== null ? `- Mentions tracked: ${e.mentions}` : "",
    `- Holdings: ${e.holdings.length}`,
    e.articles.length ? `- Recent stories: ${e.articles.length}` : "",
    e.lastSeen ? `- Last seen: ${formatDay(e.lastSeen)}` : "",
  ].filter(Boolean);
  out.push(...facts, "");

  if (e.holdings.length) {
    out.push(`## ${isPerson ? "What they’re reported to control" : "Who is reported to control it"}`, "");
    for (const h of e.holdings) {
      const lead = isPerson
        ? `${mdText(e.name)} ${mdText(describeHolding(h))} (${link(h.company, opts.entityUrl(slugify(h.company)))})`
        : `${link(h.person, opts.entityUrl(slugify(h.person)))} ${mdText(describeHolding(h))}`;
      const chips = [h.band?.label, ...h.flags.map((f) => f.title)].filter(Boolean).map(mdText);
      out.push(`- ${lead}${chips.length ? ` · ${chips.join(" · ")}` : ""}`);
      const src = h.sources[0];
      const more = h.sources.length > 1 ? ` and ${h.sources.length - 1} more` : "";
      const check = h.hasFilingRef ? "with a CAC filing reference on record" : "not verified with the CAC register";
      out.push(`  ${src ? `Reported by ${link(src.publisher || "a news report", src.url)}${more}` : "No source article on file"}, ${check}.`);
    }
    out.push("", "Extracted from news reporting by a language model. Not a CAC filing; check the sources before relying on it.", "");
  }

  const stories = e.articles.map(toStory).slice(0, 6);
  if (stories.length) {
    out.push("## In the news", "");
    for (const s of stories) {
      const when = s.published ? ` · ${formatDay(s.published.toISOString())}` : "";
      out.push(`- ${s.url ? link(s.title, s.url) : mdText(s.title)} · ${mdText(s.publisher)}${when}`);
    }
    out.push("");
  }

  if (e.moves.length) {
    out.push("## Appointments and departures", "");
    for (const m of e.moves) {
      const text = isPerson
        ? `**${mdText(m.Position || "Role")}** at ${mdText(m.Organization)}`
        : `**${mdText(m.Name)}**, ${mdText(m.Position || "role not given")}`;
      const event = m.Event && m.Event !== "other" ? ` (${mdText(m.Event)})` : "";
      out.push(`- ${m.Date ? formatDay(m.Date) : "Undated"}: ${text}${event}`);
    }
    out.push("");
  }

  if (e.contracts.length) {
    out.push("## Contracts in the news", "");
    for (const c of e.contracts) {
      out.push(`- ${mdText(c.project)}: ${mdText(c.agency)}${c.contractor ? ` → ${mdText(c.contractor)}` : ""} · ${mdText(c.source)} · ${c.amountLabel || "Value not reported"}`);
    }
    out.push("");
  }

  if (!e.holdings.length && !stories.length) out.push(`AURA has no recent reporting on ${mdText(e.name)} yet.`, "");

  out.push("---", "", `Source page: ${opts.pageUrl}`, "From AURA's machine reading of Nigerian news. Unverified; not the statutory CAC register.", "");
  return out.join("\n");
}
