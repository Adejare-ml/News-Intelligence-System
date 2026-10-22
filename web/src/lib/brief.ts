/**
 * The daily brief (report_latest.md) as structured sections, so the home
 * page can lead with its key developments and the brief page can render
 * a table of contents.
 */
import { marked } from "marked";

export interface BriefItem {
  /** The bolded lead phrase, e.g. "NCC enforces a new device policy". */
  lead: string;
  /** The sentence after the lead, plain text. */
  rest: string;
  /** The first source: link text and URL (url is "" when the model named a publisher without a link). */
  source: { name: string; url: string } | null;
  /** Every distinct source cited at the end of the bullet. */
  sources: { name: string; url: string }[];
  /** Full bullet rendered to inline HTML, citations left out (they render as `sources`). */
  html: string;
}

export interface BriefSection {
  id: string;
  title: string;
  items: BriefItem[];
  /** Paragraph-level HTML for sections that are not bullet lists. */
  html: string;
}

export interface Brief {
  title: string;
  generated: string;
  window: string;
  stats: { label: string; value: string }[];
  sections: BriefSection[];
}

/**
 * The citations at the end of a bullet, in the shapes the model writes:
 *   ([Punch](https://...))      ([Punch](https://...)).      ([Punch](url)))
 *   ({source: Vanguard News})   ({source: A}&{source: B})    ([A](u1); [B](u2))
 */
const CITE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\{\s*source:([^}]*)\}/g;

/** True when `inner` holds nothing but citations and separators (",", ";", "&", "and"). */
function onlyCitations(inner: string): boolean {
  if (!inner.includes("[") && !inner.includes("{")) return false;
  const rest = inner.replace(CITE, " ").replace(/\band\b/g, " ");
  for (const ch of rest) if (!" \t,;&".includes(ch)) return false;
  return true;
}

/**
 * Splits trailing citations off a bullet. A plain scan rather than one big
 * pattern, so odd model output can never make it slow.
 */
export function splitCitations(text: string): { body: string; sources: { name: string; url: string }[] } {
  let end = text.trimEnd().length;
  while (end > 0 && ".;,".includes(text[end - 1])) end--;
  while (end > 0 && text[end - 1] === " ") end--;
  if (text[end - 1] !== ")") return { body: text, sources: [] };
  // The tail's closing parens; the model sometimes doubles them.
  let closeFrom = end - 1;
  while (closeFrom > 0 && text[closeFrom - 1] === ")") closeFrom--;

  let start = -1;
  let inner = "";
  for (let open = text.lastIndexOf("(", end - 1); open !== -1; open = open > 0 ? text.lastIndexOf("(", open - 1) : -1) {
    if (text[open + 1] !== "[" && text[open + 1] !== "{") continue;
    // Try each way of splitting the closing parens between the last link and the group.
    for (let close = end - 1; close >= closeFrom; close--) {
      const candidate = text.slice(open + 1, close);
      if (onlyCitations(candidate)) {
        start = open;
        inner = candidate;
        break;
      }
    }
  }
  if (start === -1) return { body: text, sources: [] };

  const sources: { name: string; url: string }[] = [];
  for (const m of inner.matchAll(CITE)) {
    const name = (m[1] ?? m[3] ?? "").trim();
    const url = m[2] ?? "";
    if (name && !sources.some((s) => s.name === name && (s.url === url || !url))) sources.push({ name, url });
  }
  let body = text.slice(0, start).trim();
  if (body && !/[.!?]$/.test(body)) body += ".";
  return { body, sources };
}

export function slugHeading(text: string): string {
  return text.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * The pipeline's stat names say what each counts, so they never read as a
 * second definition of "stories today" (the site's is: distinct stories
 * published in the last 24 hours).
 */
const STAT_LABELS: Record<string, string> = {
  "total articles processed": "New articles analysed in today’s runs",
  "high risk signals": "High-risk articles today",
  "appointments logged": "Board appointments today",
  "procurement awards": "Contract awards today",
};
export function statLabel(label: string): string {
  return STAT_LABELS[label.toLowerCase()] ?? label;
}

/** Inline markdown -> HTML, with only http(s) links surviving. */
export function inlineHtml(md: string): string {
  // The brief is model-written, and marked passes raw HTML straight
  // through, so angle brackets are escaped before it ever parses.
  const safe = String(md).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = marked.parseInline(safe, { async: false }) as string;
  return html
    .replace(/<a href="(?!https?:)[^"]*"/g, "<a")
    .replace(/<a href="(https?:[^"]+)"/g, '<a href="$1" rel="noopener noreferrer" target="_blank"');
}

export function parseItem(line: string): BriefItem {
  const text = line.replace(/^\s*[-*]\s+/, "").replace(/\s{2,}$/, "").trim();
  const { body, sources } = splitCitations(text);
  const source = sources[0] ?? null;
  const bold = body.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
  const lead = bold ? bold[1].replace(/:$/, "").trim() : "";
  const rest = (bold ? bold[2] : body)
    .replace(/^[:.—–\s]+/, "")
    .replace(/\*\*/g, "")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)?[^)\s]*\)/g, "$1")
    .trim();
  return { lead, rest, source, sources, html: inlineHtml(body) };
}

export function parseBrief(md: string): Brief {
  const lines = String(md || "").replace(/\r/g, "").split("\n");
  const brief: Brief = { title: "", generated: "", window: "", stats: [], sections: [] };
  let current: BriefSection | null = null;
  let paragraph: string[] = [];

  const flush = () => {
    if (current && paragraph.length) {
      current.html += `<p>${inlineHtml(paragraph.join(" "))}</p>`;
    }
    paragraph = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("# ") && !brief.title) {
      brief.title = line.slice(2).trim();
      continue;
    }
    const meta = line.match(/^\*\*(Generated on|Run Window):\*\*\s*(.+)$/);
    if (meta) {
      if (meta[1] === "Generated on") brief.generated = meta[2].trim();
      else brief.window = meta[2].trim();
      continue;
    }
    const heading = line.match(/^#{2,3}\s+(.+)$/);
    if (heading) {
      flush();
      const title = heading[1].trim();
      current = { id: slugHeading(title), title, items: [], html: "" };
      if (title !== "Summary Statistics") brief.sections.push(current);
      continue;
    }
    if (!current) continue;
    if (current.title === "Summary Statistics") {
      const stat = line.match(/^\s*-\s+\*\*(.+?):\*\*\s*(.+)$/);
      if (stat) brief.stats.push({ label: statLabel(stat[1].trim()), value: stat[2].trim() });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      current.items.push(parseItem(line));
    } else if (/^---+$/.test(line.trim()) || /^\*Report compiled/.test(line.trim())) {
      flush();
    } else if (line.trim()) {
      paragraph.push(line.trim());
    } else {
      flush();
    }
  }
  flush();
  // Leading "Report Date / Coverage" paragraphs belong to no section.
  brief.sections = brief.sections.filter((s) => s.items.length || s.html);
  return brief;
}

/** Items that say nothing happened ("No PSC ... were identified"). */
export function isQuietItem(item: BriefItem): boolean {
  return !item.lead && /^no\s/i.test(item.rest);
}
