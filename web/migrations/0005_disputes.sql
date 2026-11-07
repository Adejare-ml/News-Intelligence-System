-- Right of reply: disputes sent from /dispute/ about a record on the site.
-- The owner reviews them (status open -> resolved by hand) and, when a
-- record is wrong, corrects or unpublishes it (scripts/unpublish.py).
-- Apply once:  npx wrangler d1 execute aura --remote --file=web/migrations/0005_disputes.sql
CREATE TABLE IF NOT EXISTS disputes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,                 -- ISO 8601, UTC
  ref          TEXT NOT NULL,                 -- the record or entity page disputed
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  relationship TEXT NOT NULL,                 -- subject | representative | other
  message      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
);

-- At most a few disputes per sender a day, so the form cannot be used to
-- flood the table or the owner's inbox. The key is an HMAC of the sender's
-- IP address under the DISPUTE_SECRET Pages secret, never the address
-- itself, and /api/dispute deletes rows from earlier days as it goes.
CREATE TABLE IF NOT EXISTS dispute_throttle (
  key   TEXT NOT NULL,
  day   TEXT NOT NULL,                        -- YYYY-MM-DD, UTC
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);
