/**
 * Every D1 query the Morning Brief makes, in one place. The endpoints ask
 * for what they need ("confirm this token") and never write SQL themselves.
 *
 * Tables: subscribers (migrations 0001, 0003, 0004), sends (0002) and
 * throttle (0004).
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

/** Sign-up mail limits per address: one mail per gap, and a few per Lagos day. */
export const MAIL_GAP_MINUTES = 10;
export const MAILS_PER_DAY = 3;

/** One subscriber as the owner's stats see it: no address. */
export interface StatRow {
  status: string;
  paused: boolean;
  created_at: string;
  confirmed_at: string | null;
  prefs: Prefs;
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

    /**
     * An unsubscribed address signing up again: pending, with the preferences
     * just chosen. A pending row is left alone, so nobody else can change what
     * the owner's own confirmation link will confirm.
     */
    async reopen(email: string, prefs: Prefs): Promise<void> {
      await db
        .prepare("UPDATE subscribers SET status = 'pending', unsubscribed_at = NULL, paused = 0, categories = ?, region = ?, frequency = ? WHERE email = ? AND status = 'unsubscribed'")
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

    /**
     * Takes one of the address's mail allowances, or returns false when it
     * has none left: mailed in the last MAIL_GAP_MINUTES, or MAILS_PER_DAY
     * times already on this Lagos day. Check and record are one statement,
     * so two sign-ups racing each other cannot both get through.
     */
    async claimMail(email: string, now: string, day: string): Promise<boolean> {
      const cutoff = new Date(Date.parse(now) - MAIL_GAP_MINUTES * 60_000).toISOString();
      const row = await db
        .prepare(
          `UPDATE subscribers SET last_mailed_at = ?, mails_today = CASE WHEN mail_day = ? THEN mails_today + 1 ELSE 1 END, mail_day = ?
           WHERE email = ? AND (last_mailed_at IS NULL OR julianday(last_mailed_at) <= julianday(?))
             AND (mail_day IS NULL OR mail_day != ? OR mails_today < ?)
           RETURNING email`,
        )
        .bind(now, day, day, email, cutoff, day, MAILS_PER_DAY)
        .first<{ email: string }>();
      return row !== null;
    },

    /**
     * Gives back a claim whose mail the provider refused, so the reader can
     * try again straight away: the last mail is dated just outside the gap
     * rather than cleared. Cleared, the stale-pending clean-up would fall
     * back to the sign-up date and could delete a row the reader has just
     * tried to use.
     */
    async releaseMail(email: string, now: string, day: string): Promise<void> {
      const open = new Date(Date.parse(now) - MAIL_GAP_MINUTES * 60_000).toISOString();
      await db
        .prepare("UPDATE subscribers SET last_mailed_at = ?, mails_today = MAX(mails_today - 1, 0) WHERE email = ? AND mail_day = ?")
        .bind(open, email, day)
        .run();
    },

    /**
     * Deletes pending sign-ups not mailed since `before` (their last mail, or
     * their sign-up when they never had one): nobody is going to confirm them,
     * and an address should not be kept for nothing. Returns how many went.
     */
    async deleteStalePending(before: string): Promise<number> {
      const { results } = await db
        .prepare("DELETE FROM subscribers WHERE status = 'pending' AND julianday(COALESCE(last_mailed_at, created_at)) < julianday(?) RETURNING email")
        .bind(before)
        .all<{ email: string }>();
      return (results ?? []).length;
    },

    /**
     * Pending sign-ups 48 to 72 hours old that have had exactly one mail:
     * the confirmation on the (Lagos) day they signed up, and nothing since.
     * Lagos is UTC+1 all year, so that day is date(created_at, '+1 hour').
     * A reminder moves mail_day on, so nobody is reminded twice.
     */
    async remindable(now: string, limit: number): Promise<Subscriber[]> {
      const { results } = await db
        .prepare(
          `SELECT ${COLUMNS} FROM subscribers
           WHERE status = 'pending' AND julianday(created_at) BETWEEN julianday(?) - 3 AND julianday(?) - 2
             AND mails_today = 1 AND mail_day = date(created_at, '+1 hour')
           ORDER BY created_at LIMIT ?`,
        )
        .bind(now, now, limit)
        .all<Row>();
      return (results ?? []).map((r) => fromRow(r)!);
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
    async statRows(): Promise<StatRow[]> {
      const { results } = await db
        .prepare("SELECT status, categories, region, frequency, paused, created_at, confirmed_at FROM subscribers")
        .bind()
        .all<{ status: string; categories: string; region: string; frequency: string; paused: number; created_at: string; confirmed_at: string | null }>();
      return (results ?? []).map((r) => ({
        status: r.status,
        paused: Number(r.paused) === 1,
        created_at: r.created_at,
        confirmed_at: r.confirmed_at ?? null,
        prefs: prefsFromRow(r),
      }));
    },
  };
}

/** Counts per key per Lagos day, e.g. sign-up posts from one IP ("ip:<address>"). */
export function throttle(db: D1Like) {
  return {
    /** Counts one hit and returns today's total for the key, this one included. */
    async hit(key: string, day: string): Promise<number> {
      const row = await db
        .prepare(
          `INSERT INTO throttle (key, day, count) VALUES (?, ?, 1)
           ON CONFLICT (key) DO UPDATE SET count = CASE WHEN throttle.day = excluded.day THEN throttle.count + 1 ELSE 1 END, day = excluded.day
           RETURNING count`,
        )
        .bind(key, day)
        .first<{ count: number }>();
      return Number(row?.count ?? 1);
    },

    /** Drops counts from before `day`: they no longer limit anyone, and IPs need not be kept. */
    async prune(day: string): Promise<void> {
      await db.prepare("DELETE FROM throttle WHERE day < ?").bind(day).run();
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
