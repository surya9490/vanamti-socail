-- ============================================================
-- Migration 054 — two-stage re-engagement tracking on contacts.
--
-- The original Phase 5 cron (migration 051 + the cron endpoint)
-- sends a single re-engagement template after N days of silence.
-- Operator wants a graduated cadence for COLD contacts (never
-- showed buying interest, per Phase 4 grading):
--   Stage 1: 3 hours after their last message
--   Stage 2: 24 hours after their last message
--
-- Each stage sends a different Meta-approved MARKETING template.
-- Once a stage has been sent to a contact, it never fires again
-- for that contact — the per-column timestamp is the idempotency
-- key.
--
-- Old last_re_engagement_at column (migration 051) is left in
-- place for backwards compat; the new cron ignores it.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS re_engagement_stage_1_at TIMESTAMPTZ;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS re_engagement_stage_2_at TIMESTAMPTZ;

-- Partial indexes: the cron only reads these to filter "still-
-- eligible-for-stage-N" contacts. Non-null rows are a small
-- subset (already-engaged), so partial keeps the index tiny.
CREATE INDEX IF NOT EXISTS idx_contacts_reeng_stage_1
  ON contacts (re_engagement_stage_1_at)
  WHERE re_engagement_stage_1_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_reeng_stage_2
  ON contacts (re_engagement_stage_2_at)
  WHERE re_engagement_stage_2_at IS NOT NULL;
