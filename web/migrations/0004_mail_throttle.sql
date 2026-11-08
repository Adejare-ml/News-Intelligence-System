-- Sign-up mail limits, so the form cannot be used to flood an inbox or to
-- burn the provider's daily quota. Per address: when it was last mailed and
-- how many mails it has had on the current Lagos day. Per sign-up source
-- (an IP, as "ip:<address>"): how many sign-up posts it made today.
-- Apply once:  npx wrangler d1 execute aura --remote --file=web/migrations/0004_mail_throttle.sql
ALTER TABLE subscribers ADD COLUMN last_mailed_at TEXT;
ALTER TABLE subscribers ADD COLUMN mail_day       TEXT;                        -- Lagos date, YYYY-MM-DD
ALTER TABLE subscribers ADD COLUMN mails_today    INTEGER NOT NULL DEFAULT 0;  -- mails on mail_day
CREATE TABLE IF NOT EXISTS throttle (
  key    TEXT PRIMARY KEY,
  day    TEXT NOT NULL,              -- Lagos date the count belongs to
  count  INTEGER NOT NULL DEFAULT 0
);
