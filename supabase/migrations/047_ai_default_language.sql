-- ============================================================
-- 047_ai_default_language.sql
--
-- Adds an optional default language on ai_configs. The AI prompt used
-- to say "reply in the same language the customer is writing in" and
-- stop there — so if the customer's first message was unclear about
-- language (a single emoji, an ambiguous word like "hi"), the model
-- picked something on vibes. That's usually fine but not deterministic:
-- a Vanamati customer opening with "🙏" could get Hindi one turn and
-- English the next.
--
-- `default_language` (BCP-47 subset like 'en', 'hi', 'en-IN') fixes
-- the fallback so:
--   1. Customer writes in a clear language → reply in that language.
--   2. Customer's language is unclear/ambiguous → reply in
--      default_language.
--   3. Column is null → reply in English (the pre-existing implicit
--      behaviour, kept for accounts that don't opt in).
--
-- Length CHECK bounds the field so nobody stuffs a paragraph in — it's
-- fed to the model verbatim.
--
-- Idempotent — safe to re-apply.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS default_language text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_configs_default_language_check'
      AND conrelid = 'ai_configs'::regclass
  ) THEN
    ALTER TABLE ai_configs
      ADD CONSTRAINT ai_configs_default_language_check
      CHECK (default_language IS NULL OR length(default_language) BETWEEN 2 AND 16);
  END IF;
END $$;
