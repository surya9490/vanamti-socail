-- ============================================================
-- Migration 055 — configurable re-engagement stages.
--
-- Replaces the two hard-coded env-var stages (migration 054 +
-- the RE_ENGAGEMENT_STAGE_N_* envs) with a table the operator
-- edits from the /agents "Re-engagement" tab. Each row is one
-- stage: a name, a delay in hours, a Meta template to send.
--
-- Idempotency moves from the two ad-hoc contact columns
-- (re_engagement_stage_1_at / _2_at) to a proper per-stage sends
-- table. The old columns are left in place — nothing reads them
-- any more, but dropping is bookkeeping for later.
-- ============================================================

CREATE TABLE IF NOT EXISTS re_engagement_stages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- Human label ("3h nudge", "24h check-in", "7d we miss you").
  -- Only shown in the config UI; never sent to customers.
  name TEXT NOT NULL,

  -- Hours of customer silence before this stage fires.
  -- Operator picks the value; cron enforces min-gap between
  -- adjacent stages by ordering by hours_after.
  hours_after INTEGER NOT NULL CHECK (hours_after > 0),

  -- Meta-approved template name + language. The template must
  -- exist and be APPROVED for the sender's WABA — the cron
  -- doesn't second-guess Meta; a bad name errors at send time.
  template_name TEXT NOT NULL,
  template_language TEXT NOT NULL DEFAULT 'en',

  -- 'text' = plain body template, no params
  -- 'carousel' = the account's product carousel (uses the same
  --   card layout as the send_product_carousel AI tool — per-card
  --   {{1}}=title {{2}}=price; URL button {{1}}=handle).
  template_type TEXT NOT NULL DEFAULT 'text'
    CHECK (template_type IN ('text', 'carousel')),

  -- Per-stage on/off. Operator can pause a stage without deleting.
  enabled BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_re_engagement_stages_account
  ON re_engagement_stages (account_id, hours_after)
  WHERE enabled = TRUE;

-- Trigger to bump updated_at (uses the existing helper installed
-- by migration 001).
DROP TRIGGER IF EXISTS set_updated_at ON re_engagement_stages;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON re_engagement_stages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS. Same policy shape as other account-scoped tables:
-- only members of the account (via accounts.owner_user_id or the
-- account_users membership introduced in migration 017) can read
-- or write their stages.
ALTER TABLE re_engagement_stages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read stages" ON re_engagement_stages;
CREATE POLICY "members read stages" ON re_engagement_stages
  FOR SELECT USING (
    account_id IN (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "admins write stages" ON re_engagement_stages;
CREATE POLICY "admins write stages" ON re_engagement_stages
  FOR ALL USING (
    account_id IN (
      SELECT account_id FROM profiles
        WHERE user_id = auth.uid()
          AND account_role IN ('owner', 'admin')
    )
  );

-- ============================================================
-- Per-stage send idempotency. One row = "we sent stage X to
-- contact Y at time T". Primary key on (contact_id, stage_id)
-- means each stage fires at most once per contact, forever.
-- Deleting a stage cascades away its send rows (they're only
-- meaningful relative to a stage that exists).
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_re_engagement_sends (
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  stage_id   UUID NOT NULL REFERENCES re_engagement_stages(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, stage_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_reeng_sends_account
  ON contact_re_engagement_sends (account_id, sent_at DESC);

ALTER TABLE contact_re_engagement_sends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read sends" ON contact_re_engagement_sends;
CREATE POLICY "members read sends" ON contact_re_engagement_sends
  FOR SELECT USING (
    account_id IN (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );
-- No public write policy — only the cron (service-role) inserts.
