-- ============================================================
-- Migration 050 — lead_stage on contacts.
--
-- The AI auto-reply grades every customer conversation as
-- hot / warm / cold based on the last exchange. This column stores
-- the current grade so agents can filter the inbox by lead
-- quality ("show me all hot leads").
--
-- Ratchet semantics (enforced in code, not the DB): once a contact
-- has been graded hot, they stay hot until a human overrides it —
-- a subsequent "hi" from the same customer shouldn't demote them
-- from hot to cold and lose the sales signal. Ordering used:
-- cold (1) < warm (2) < hot (3). See src/lib/ai/grading.ts.
--
-- lead_stage_updated_at supports "recently upgraded to hot" queries
-- (a follow-up cadence for sales agents).
--
-- CHECK enforces the enum at the DB level so a bad prompt / stray
-- tool response can never land an unexpected value.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_stage TEXT
    CHECK (lead_stage IN ('hot', 'warm', 'cold'));

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_stage_updated_at TIMESTAMPTZ;

-- Partial index: only graded contacts are queried by lead_stage;
-- the vast majority of rows (ungraded) don't need to sit in the
-- index and inflate its size.
CREATE INDEX IF NOT EXISTS idx_contacts_lead_stage
  ON contacts (lead_stage)
  WHERE lead_stage IS NOT NULL;
