/**
 * Turning latest.json rows into stories a reader wants to open.
 */

export interface Article {
  ID?: number | string;
  Time?: string;
  Title?: string;
  Source?: string;
  URL?: string;
  Category?: string;
  "Risk Score"?: number | string;
  "Risk Level"?: string;
  Summary?: string;
  "Event Type"?: string;
  Importance?: number | string;
  Entities?: string;
  Image?: string;
}

export interface Story {
  id: string;
  title: string;
  publisher: string;
  url: string;
  summary: string;
  category: string;
  eventType: string;
  risk: number;
  riskLevel: "Critical" | "High" | "Medium" | "Low";
  importance: number;
  entities: string[];
  image: string;
  published: Date | null;
  cover: Cover;
}

export interface Cover {
  /** Gradient angle and two-stop hue pair, deterministic per story. */
  angle: number;
  tone: "royal" | "gold" | "ink" | "crimson";
  glyph: string;
  /** Seeded offsets for the dot-matrix pattern on the cover. */
  seed: number;
}

const TAIL_RE = /\s+[-–—|]\s+([^-–—|]+)$/;

/** Headline without the " - Publisher" suffix Google News appends. */
export function cleanTitle(title: string, source = ""): { title: string; publisher: string } {
  // Feeds sometimes leave a dangling separator: "... investor of $120m |".
  const text = String(title || "").trim().replace(/\s*[|–—-]+\s*$/, "");
  const src = String(source || "").trim();
  // "... of $120m | - The Eagle Online": the separator left behind once
  // the publisher is cut is dropped too.
  const tidy = (t: string) => t.trim().replace(/\s*[|–—-]+\s*$/, "").trim();
  for (const sep of [" - ", " | ", " – ", " — "]) {
    if (src && text.toLowerCase().endsWith((sep + src).toLowerCase())) {
      return { title: tidy(text.slice(0, -(sep.length + src.length))), publisher: src };
    }
  }
  const m = text.match(TAIL_RE);
  if (m && m[1].trim().split(/\s+/).length <= 6) {
    return { title: tidy(text.slice(0, m.index)), publisher: m[1].trim() };
  }
  return { title: text, publisher: src };
}

/** Readable publisher name: "sunnewsonline" is a feed id, "The Sun" is a name. */
const PUBLISHER_NAMES: Record<string, string> = {
  sunnewsonline: "The Sun",
  punchng: "The Punch",
  "punch newspapers": "The Punch",
  "the guardian nigeria news - nigeria and world news": "The Guardian Nigeria",
  "the guardian nigeria news": "The Guardian Nigeria",
  thecable: "TheCable",
  premiumtimesng: "Premium Times",
  "premium times nigeria": "Premium Times",
  vanguardngr: "Vanguard",
  "vanguard news": "Vanguard",
  businessday: "BusinessDay",
  channelstv: "Channels TV",
  dailytrust: "Daily Trust",
  thisdaylive: "ThisDay",
  nairametrics: "Nairametrics",
};

export function publisherName(raw: string): string {
  const key = String(raw || "").trim().toLowerCase();
  return PUBLISHER_NAMES[key] || String(raw || "").trim() || "Unknown source";
}

/**
 * Pipeline timestamps come in three shapes: ISO with Z, "YYYY-MM-DD HH:MM:SS"
 * (written in UTC by the runner), and RFC 2822 from RSS. All are read as UTC.
 */
export function parseTime(value: unknown): Date | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const sqlish = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text);
  const d = new Date(sqlish ? text.replace(" ", "T") + "Z" : text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function riskLevelFor(score: number, stored?: string): Story["riskLevel"] {
  const s = String(stored || "").toLowerCase();
  if (s === "critical" || s === "high" || s === "medium" || s === "low") {
    return (s[0].toUpperCase() + s.slice(1)) as Story["riskLevel"];
  }
  if (score >= 75) return "Critical";
  if (score >= 50) return "High";
  if (score >= 30) return "Medium";
  return "Low";
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const STOP_GLYPH = new Set(["the", "a", "an", "fg", "of", "in", "for", "on"]);

export function coverFor(title: string, category: string, riskLevel: Story["riskLevel"]): Cover {
  const h = hash(title + category);
  const tone: Cover["tone"] = riskLevel === "Critical" ? "crimson"
    : riskLevel === "High" ? "gold"
    : category === "Government" || category === "Legal" ? "royal" : "ink";
  const firstWord = title.split(/\s+/).find((w) => w && !STOP_GLYPH.has(w.toLowerCase())) || title;
  const glyph = (firstWord.replace(/[^A-Za-z0-9₦$]/g, "").slice(0, 4) || "A").toUpperCase();
  return { angle: 110 + (h % 70), tone, glyph, seed: h % 1000 };
}

export function toStory(a: Article): Story {
  const { title, publisher } = cleanTitle(String(a.Title || ""), String(a.Source || ""));
  const risk = num(a["Risk Score"]);
  const riskLevel = riskLevelFor(risk, a["Risk Level"]);
  const category = String(a.Category || "Other");
  return {
    id: String(a.ID ?? hash(String(a.URL || title))),
    title,
    publisher: publisherName(publisher || String(a.Source || "")),
    url: String(a.URL || ""),
    summary: String(a.Summary || "").trim(),
    category,
    eventType: String(a["Event Type"] || "Other"),
    risk,
    riskLevel,
    importance: num(a.Importance, 50),
    entities: String(a.Entities || "").split("|").map((e) => e.trim()).filter(Boolean),
    image: String(a.Image || ""),
    published: parseTime(a.Time),
    cover: coverFor(title, category, riskLevel),
  };
}

/**
 * Front-page order: importance and risk matter most, but a two-day-old
 * story should not outrank this morning's. Ties go to the newest.
 */
export function storyScore(s: Story, now: Date): number {
  const ageHours = s.published ? Math.max(0, (now.getTime() - s.published.getTime()) / 36e5) : 72;
  const freshness = Math.max(0, 1 - ageHours / 72); // 1 now, 0 at three days
  const imageBonus = s.image ? 4 : 0;
  return s.importance * 0.45 + s.risk * 0.35 + freshness * 30 + imageBonus;
}

const DUP_STOP = new Set(["the", "a", "an", "of", "in", "on", "for", "to", "and", "as", "at", "by", "with", "is", "its", "from"]);

function titleTokens(title: string): string[] {
  return title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter((w) => w && !DUP_STOP.has(w));
}

/**
 * Two outlets' headlines for one event ("FAAN begins earning MMA2 revenue
 * as dispute ends" / "FAAN starts earning MMA2 revenue as 20-year dispute
 * ends"): the same opening words, or mostly the same words.
 */
export function isNearDuplicate(a: string, b: string): boolean {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta.length >= 5 && ta.slice(0, 8).join(" ") === tb.slice(0, 8).join(" ")) return true;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / (sa.size + sb.size - shared) >= 0.6;
}

/** Stories with exact and near-duplicate headlines removed, best first. */
export function dedupeStories(stories: Story[], now: Date): Story[] {
  const ranked = [...stories].sort((a, b) => storyScore(b, now) - storyScore(a, now)
    || (b.published?.getTime() ?? 0) - (a.published?.getTime() ?? 0));
  const kept: Story[] = [];
  for (const s of ranked) {
    if (!s.title) continue;
    if (kept.some((k) => k.title.toLowerCase() === s.title.toLowerCase() || isNearDuplicate(k.title, s.title))) continue;
    kept.push(s);
  }
  return kept;
}

export function rankStories(articles: Article[], now: Date, limit = 9): Story[] {
  return dedupeStories((articles || []).map(toStory), now).slice(0, limit);
}

/** The one definition of "stories today": distinct stories in the 24h before `at`. */
export function storiesInDay(articles: Article[], at: Date): number {
  const recent = (articles || []).map(toStory).filter((s) =>
    s.published && at.getTime() - s.published.getTime() < 36e5 * 24 && s.published.getTime() <= at.getTime() + 36e5);
  return dedupeStories(recent, at).length;
}

/** "3h ago", "Yesterday", "18 Oct". Reference time is passed in so builds are reproducible. */
export function relativeTime(date: Date | null, now: Date): string {
  if (!date) return "";
  const mins = Math.round((now.getTime() - date.getTime()) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "Yesterday";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Lagos" });
}
