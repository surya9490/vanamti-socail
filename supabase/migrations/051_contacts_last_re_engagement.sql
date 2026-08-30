-- ============================================================
-- Migration 051 — last_re_engagement_at on contacts.
--
-- Timestamp of the most recent re-engagement message the AI cron
-- sent to this contact. Powers the cooldown check ("don't message
-- the same customer twice within N days") in
-- src/app/api/cron/re-engagement/route.ts.
--
-- NULL = never re-engaged; the cron treats these as eligible on
-- their first qualifying sweep.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS last_re_engagement_at TIMESTAMPTZ;

-- Partial index: re-engaged contacts are a small subset and the
-- cron only reads this to filter (WHERE last_re_engagement_at IS
-- NULL OR last_re_engagement_at < NOW() - INTERVAL 'X days'), not
-- for range queries — partial keeps the index compact.
CREATE INDEX IF NOT EXISTS idx_contacts_last_re_engagement
  ON contacts (last_re_engagement_at)
  WHERE last_re_engagement_at IS NOT NULL;
