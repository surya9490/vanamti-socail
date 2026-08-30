-- ============================================================
-- Migration 052 — contact_id on ai_usage_log for per-contact caps.
--
-- Adds a nullable contact_id column so the auto-reply dispatcher
-- can query "how many tokens did we spend on this contact in the
-- last 24h" cheaply, then skip a reply if the per-contact daily
-- budget is exhausted. Protects against a malicious or broken
-- customer sending 1,000 messages/day = ₹1,500/day in provider
-- spend on the BYO key.
--
-- Nullable because existing rows have no contact_id — the auto-
-- reply gate treats missing rows as "0 tokens spent" (skipped
-- from the sum), so the budget is enforced only on the going-
-- forward window. No backfill needed for correctness.
-- ============================================================

ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS contact_id UUID
    REFERENCES contacts(id) ON DELETE SET NULL;

-- Query: SUM(total_tokens) WHERE account_id=X AND contact_id=Y
-- AND created_at > NOW() - INTERVAL '24 hours'
-- Composite index optimises exactly that.
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_contact_created
  ON ai_usage_log (contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;
