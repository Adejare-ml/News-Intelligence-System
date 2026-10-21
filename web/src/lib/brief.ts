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
  /** Source link text and URL when the bullet ends with ([Publisher](url)). */
  source: { name: string; url: string } | null;
  /** Full bullet rendered to inline HTML. */
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

// The model sometimes doubles the closing paren: "([Punch](url)))".
const LINK_TAIL = /\s*\(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\)+\s*$/;

export function slugHeading(text: string): string {
  return text.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
  let body = text;
  let source: BriefItem["source"] = null;
  const tail = body.match(LINK_TAIL);
  if (tail) {
    source = { name: tail[1], url: tail[2] };
    body = body.slice(0, tail.index).trim();
  }
  const bold = body.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
  const lead = bold ? bold[1].replace(/:$/, "").trim() : "";
  const rest = (bold ? bold[2] : body).replace(/^[:.—–\s]+/, "").replace(/\*\*/g, "").trim();
  return { lead, rest, source, html: inlineHtml(text) };
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
      if (stat) brief.stats.push({ label: stat[1].trim(), value: stat[2].trim() });
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
