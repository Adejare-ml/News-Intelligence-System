/**
 * The Morning Brief email edition, written by the pipeline
 * (backend/app/services/email_digest.py) as email_digest.json.
 */
export interface DigestLink {
  outlet: string;
  url: string;
}

export interface DigestCard {
  n: number;
  theme: string;
  event_type: string;
  flags: string[];
  alert: boolean;
  risk: string;
  headline: string;
  byline: string;
  outlet: string;
  what_happened: string;
  key_facts: string[];
  timeline: string[];
  headline_only: boolean;
  analysis: string[];
  ownership_caveat: string;
  named: string[];
  source: DigestLink;
  also_reported: DigestLink[];
  also_more: number;
}

export interface EmailDigest {
  edition: string;
  built_at: string;
  date: string;
  subject: string;
  preheader: string;
  since: string;
  through_id: number;
  stats: {
    reports: number;
    stories: number;
    outlets: number;
    risk_alerts: number;
    public_money: number;
    appointments: number;
    ownership: number;
  };
  nothing_in: string[];
  overview: { text: string; card: number; outlet: string }[];
  insights: { label: string; text: string; cards: number[]; outlets: string[] }[];
  cards: DigestCard[];
  also: { n: number; theme: string; text: string; outlet: string; url: string }[];
  also_more: number;
  psc: { text: string; outlet: string; date: string; url: string }[];
  terms: { term: string; meaning: string }[];
  engines: { extraction: string[]; digest: string };
  health: Record<string, number | string>;
  site: string;
}

/** A usable edition, or null when the file is missing or malformed. */
export function readDigest(value: unknown): EmailDigest | null {
  const d = value as EmailDigest | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.cards) || !d.stats || !d.edition) return null;
  return d;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
