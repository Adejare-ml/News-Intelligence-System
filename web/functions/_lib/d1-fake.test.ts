/**
 * A D1 stand-in for tests, backed by Node's built-in SQLite and the real
 * migrations, so tests exercise the SQL the site runs rather than a mock
 * that matches query prefixes.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Like } from "./http.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

const value = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v);

export function sqliteD1(): D1Like & { raw: DatabaseSync; queries: string[] } {
  const raw = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const queries: string[] = [];
  return {
    raw,
    queries,
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const stmt = raw.prepare(sql);
          const args = values.map(value) as (string | number | null)[];
          return {
            async first<T>() {
              queries.push(sql);
              return ((stmt.get(...args) as T | undefined) ?? null) as T | null;
            },
            async all<T>() {
              queries.push(sql);
              return { results: stmt.all(...args) as T[] };
            },
            async run() {
              queries.push(sql);
              return stmt.run(...args);
            },
          };
        },
      };
    },
  };
}

/** Adds a subscriber row directly, for test setup. */
export function addSubscriber(
  db: ReturnType<typeof sqliteD1>,
  row: { email: string; token: string; status?: string; categories?: string; region?: string; frequency?: string; paused?: number; created_at?: string },
): void {
  db.raw
    .prepare("INSERT INTO subscribers (email, token, status, created_at, categories, region, frequency, paused) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.email, row.token, row.status ?? "confirmed", row.created_at ?? "2026-11-01T07:00:00.000Z", row.categories ?? "business", row.region ?? "nigeria", row.frequency ?? "daily", row.paused ?? 0);
}
