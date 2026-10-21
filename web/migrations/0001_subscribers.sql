-- Morning Brief subscribers (Cloudflare D1, bound to the Pages project as DB).
-- Apply once:  npx wrangler d1 execute aura --remote --file=web/migrations/0001_subscribers.sql
CREATE TABLE IF NOT EXISTS subscribers (
  email         TEXT PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | unsubscribed
  created_at    TEXT NOT NULL,
  confirmed_at  TEXT,
  unsubscribed_at TEXT
);
CREATE INDEX IF NOT EXISTS subscribers_status ON subscribers (status);
