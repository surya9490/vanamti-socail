-- ============================================================
-- Migration 057 — close-nudge tracking.
--
-- The AI now sends short, warm follow-ups when a customer goes
-- silent RIGHT before completing an order — the highest-value
-- moments in the funnel:
--   1. address_ask       — bot asked for the shipping address
--   2. address_confirm   — bot showed the full delivery summary
--                          and asked to confirm
--   3. payment_link_sent — bot delivered the checkout URL
--
-- Each stage nudges at most twice per conversation. This table is
-- the idempotency + rate-limit ledger: one row per nudge sent.
-- The cron uses it to decide "already nudged N times for this
-- stage, skip" and to avoid double-nudging when the cron overlaps.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_close_nudges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- Which close-stage this nudge was for. Free-text (validated by
  -- the cron code) so we can add new stages later without a schema
  -- migration.
  stage TEXT NOT NULL,

  -- 1 for the first nudge in this stage, 2 for the second, etc.
  -- Cron enforces the per-stage max.
  nudge_number INTEGER NOT NULL CHECK (nudge_number > 0),

  -- The conversations.messages row id we inserted (so we can
  -- back-link nudges to the actual message bubble the agent sees).
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,

  -- The bot message the nudge was FOLLOWING UP — used to detect
  -- stage-reset (if the bot has since spoken a newer close-adjacent
  -- message, we start fresh count from that one).
  triggering_bot_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,

  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cron's inner loop asks: "how many nudges have I sent for THIS
-- bot message on THIS stage?" — index that.
CREATE INDEX IF NOT EXISTS idx_close_nudges_triggering
  ON conversation_close_nudges (triggering_bot_message_id, stage);

-- Analytics + "last nudge for a given convo" queries.
CREATE INDEX IF NOT EXISTS idx_close_nudges_conv_sent
  ON conversation_close_nudges (conversation_id, sent_at DESC);

ALTER TABLE conversation_close_nudges ENABLE ROW LEVEL SECURITY;

-- Members of the account can read their own nudges (for the audit
-- log / analytics later). No public write policy — only the cron
-- (service-role) inserts.
DROP POLICY IF EXISTS "members read close nudges" ON conversation_close_nudges;
CREATE POLICY "members read close nudges" ON conversation_close_nudges
  FOR SELECT USING (
    account_id IN (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );
