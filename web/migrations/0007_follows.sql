-- Follow by email: companies a reader wants in the "Following" part of their
-- Morning Brief, keyed by the subscriber's token (no address stored twice).
-- At most 20 per reader, enforced in code (functions/_lib/follows.ts).
-- follow_requests throttles the "Get updates by email" form on entity pages:
-- one email per address every 10 minutes. Rows older than a day are deleted
-- each time the form is used and by the daily brief send (/api/send-brief).
-- Apply once:  npx wrangler d1 execute aura --remote --file=web/migrations/0007_follows.sql
CREATE TABLE IF NOT EXISTS follows (
  token       TEXT NOT NULL,
  slug        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (token, slug)
);
CREATE TABLE IF NOT EXISTS follow_requests (
  email         TEXT PRIMARY KEY,
  requested_at  TEXT NOT NULL
);
