-- Reader analytics without tracking readers: one row per Lagos day, page
-- path and source (e.g. "brief-20261107-11218" for a Morning Brief link),
-- holding only a count. No IP address, user agent, cookie or identifier is
-- ever stored, so no row can be tied to a person.
-- Apply once:  npx wrangler d1 execute aura --remote --file=web/migrations/0006_hits.sql
CREATE TABLE IF NOT EXISTS hits (
  day     TEXT NOT NULL,              -- Lagos date, YYYY-MM-DD
  path    TEXT NOT NULL,              -- page path, no query string
  source  TEXT NOT NULL DEFAULT '',   -- '' for a plain visit
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, source)
);
