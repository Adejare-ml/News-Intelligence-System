/**
 * Every D1 query the Morning Brief makes, in one place. The endpoints ask
 * for what they need ("confirm this token") and never write SQL themselves.
 *
 * Tables: subscribers (migrations 0001 + 0003) and sends (0002).
 */
import type { D1Like } from "./http.ts";
import { prefsFromRow, serializeCategories, type Prefs } from "./categories.ts";

export type Status = "pending" | "confirmed" | "unsubscribed";

export interface Subscriber extends Prefs {
  email: string;
  token: string;
  status: Status;
  paused: boolean;
}

interface Row {
  email: string;
  token: string;
  status: string;
  categories?: string;
  region?: string;
  frequency?: string;
  paused?: number;
}

const COLUMNS = "email, token, status, categories, region, frequency, paused";

function fromRow(row: Row | null): Subscriber | null {
  if (!row) return null;
  return {
    email: row.email,
    token: row.token,
    status: row.status as Status,
    paused: Number(row.paused ?? 0) === 1,
    ...prefsFromRow(row),
  };
}

const prefValues = (p: Prefs) => [serializeCategories(p.categories), p.region, p.frequency];

export function subscriberStore(db: D1Like) {
  return {
    async byEmail(email: string): Promise<Subscriber | null> {
      return fromRow(await db.prepare(`SELECT ${COLUMNS} FROM subscribers WHERE email = ?`).bind(email).first<Row>());
    },

    async byToken(token: string): Promise<Subscriber | null> {
      return fromRow(await db.prepare(`SELECT ${COLUMNS} FROM subscribers WHERE token = ?`).bind(token).first<Row>());
    },

    async create(email: string, token: string, prefs: Prefs, now: string): Promise<void> {
      await db
        .prepare("INSERT INTO subscribers (email, token, status, created_at, categories, region, frequency) VALUES (?, ?, 'pending', ?, ?, ?, ?)")
        .bind(email, token, now, ...prefValues(prefs))
        .run();
    },

    /** A pending or unsubscribed address signing up again: pending, with the preferences just chosen. */
    async reopen(email: string, prefs: Prefs): Promise<void> {
      await db
        .prepare("UPDATE subscribers SET status = 'pending', unsubscribed_at = NULL, paused = 0, categories = ?, region = ?, frequency = ? WHERE email = ? AND status != 'confirmed'")
        .bind(...prefValues(prefs), email)
        .run();
    },

    async confirm(token: string, now: string): Promise<void> {
      await db
        .prepare("UPDATE subscribers SET status = 'confirmed', confirmed_at = ?, unsubscribed_at = NULL WHERE token = ? AND status != 'confirmed'")
        .bind(now, token)
        .run();
    },

    async unsubscribe(token: string, now: string): Promise<void> {
      await db.prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ? WHERE token = ?").bind(now, token).run();
    },

    async updatePrefs(token: string, prefs: Prefs, paused: boolean): Promise<void> {
      await db
        .prepare("UPDATE subscribers SET categories = ?, region = ?, frequency = ?, paused = ? WHERE token = ?")
        .bind(...prefValues(prefs), paused ? 1 : 0, token)
        .run();
    },

    /** Everyone who should get a brief at all: confirmed and not paused. Frequency is the caller's call. */
    async recipients(): Promise<Subscriber[]> {
      const { results } = await db
        .prepare(`SELECT ${COLUMNS} FROM subscribers WHERE status = 'confirmed' AND paused = 0 ORDER BY email`)
        .bind()
        .all<Row>();
      return (results ?? []).map((r) => fromRow(r)!);
    },

    /** Rows for the owner's stats: preferences and dates only, never an address. */
    async statRows(): Promise<{ status: string; paused: boolean; created_at: string; prefs: Prefs }[]> {
      const { results } = await db
        .prepare("SELECT status, categories, region, frequency, paused, created_at FROM subscribers")
        .bind()
        .all<{ status: string; categories: string; region: string; frequency: string; paused: number; created_at: string }>();
      return (results ?? []).map((r) => ({ status: r.status, paused: Number(r.paused) === 1, created_at: r.created_at, prefs: prefsFromRow(r) }));
    },
  };
}

export interface SendRow {
  day: string;
  edition: string;
  started_at: string;
  finished_at: string | null;
  sent: number;
  failed: number;
}

export function sendLog(db: D1Like) {
  return {
    async forDay(day: string): Promise<SendRow | null> {
      return db.prepare("SELECT day, edition, started_at, finished_at, sent, failed FROM sends WHERE day = ?").bind(day).first<SendRow>();
    },

    /** The day an edition was last sent in full, if ever. */
    async sentOn(edition: string): Promise<string | null> {
      const row = await db.prepare("SELECT day FROM sends WHERE edition = ? AND finished_at IS NOT NULL").bind(edition).first<{ day: string }>();
      return row?.day ?? null;
    },

    async start(day: string, edition: string, now: string): Promise<void> {
      await db.prepare("INSERT INTO sends (day, edition, started_at) VALUES (?, ?, ?)").bind(day, edition, now).run();
    },

    async finish(day: string, sent: number, failed: number, now: string): Promise<void> {
      await db.prepare("UPDATE sends SET finished_at = ?, sent = ?, failed = ? WHERE day = ?").bind(now, sent, failed, day).run();
    },

    async recent(limit: number): Promise<SendRow[]> {
      const { results } = await db
        .prepare("SELECT day, edition, started_at, finished_at, sent, failed FROM sends ORDER BY day DESC LIMIT ?")
        .bind(limit)
        .all<SendRow>();
      return results ?? [];
    },
  };
}
