/**
 * Brief editions: every archived report_YYYYMMDD_HHMMSS.md becomes a
 * permanent page at /brief/YYYYMMDD-HHMMSS/.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Edition {
  slug: string;
  file: string;
  date: Date;
  /** YYYY-MM-DD (UTC) for grouping. */
  day: string;
}

const NAME_RE = /^report_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.md$/;

export function editionFromFile(file: string): Edition | null {
  const m = file.match(NAME_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if (Number.isNaN(date.getTime())) return null;
  return { slug: `${y}${mo}${d}-${h}${mi}${s}`, file, date, day: `${y}-${mo}-${d}` };
}

function archiveDir(): string {
  const base = process.env.AURA_DATA_DIR
    ? resolve(process.env.AURA_DATA_DIR)
    : resolve(process.cwd(), "../backend/app/static/data");
  return resolve(base, "archives");
}

/** All editions, newest first. */
export function listEditions(): Edition[] {
  const dir = archiveDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(editionFromFile)
    .filter((e): e is Edition => e !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

export function readEdition(edition: Edition): string {
  return readFileSync(resolve(archiveDir(), edition.file), "utf-8");
}

/** Group editions by day, newest day first. */
export function byDay(editions: Edition[]): { day: string; editions: Edition[] }[] {
  const map = new Map<string, Edition[]>();
  for (const e of editions) {
    const list = map.get(e.day);
    if (list) list.push(e);
    else map.set(e.day, [e]);
  }
  return [...map.entries()].map(([day, list]) => ({ day, editions: list }));
}
