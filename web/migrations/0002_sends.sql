-- One row per Morning Brief send, so a retried or doubled trigger never
-- emails anyone twice and a stale edition is never sent again.
-- Apply once:  npx wrangler d1 execute aura --remote --file=web/migrations/0002_sends.sql
CREATE TABLE IF NOT EXISTS sends (
  day          TEXT PRIMARY KEY,   -- Lagos date of the send, YYYY-MM-DD
  edition      TEXT NOT NULL,      -- archive slug of the brief that was sent
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  sent         INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0
);
