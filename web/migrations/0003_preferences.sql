-- Reader preferences for the Morning Brief: which kinds of news, from
-- which region, how often, and whether delivery is paused. Existing rows
-- get the brief they already had: business, Nigeria, daily.
-- Apply once:  npx wrangler d1 execute aura --remote --file=web/migrations/0003_preferences.sql
ALTER TABLE subscribers ADD COLUMN categories TEXT NOT NULL DEFAULT 'business';  -- comma-separated ids
ALTER TABLE subscribers ADD COLUMN region     TEXT NOT NULL DEFAULT 'nigeria';   -- nigeria | global | both
ALTER TABLE subscribers ADD COLUMN frequency  TEXT NOT NULL DEFAULT 'daily';     -- daily | weekly
ALTER TABLE subscribers ADD COLUMN paused     INTEGER NOT NULL DEFAULT 0;
