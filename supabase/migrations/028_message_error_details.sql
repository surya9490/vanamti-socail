-- ============================================================
-- 028_message_error_details.sql
--
-- Adds Meta failure details to messages. Meta's status webhook for
-- a `failed` message includes:
--   errors[0].code      integer error code (e.g. 132000)
--   errors[0].title     short human title
--   errors[0].message   detailed message (often same as title)
--
-- Before this migration the webhook handler kept only status='failed'
-- and the DIAGNOSTIC (which template, which param, which recipient)
-- had to be recovered by trawling Railway logs OR jumping to Meta's
-- WhatsApp Manager → Insights → Delivery. Storing the fields locally
-- lets the inbox UI show "Failed: (#132000) template params mismatch"
-- inline on the failed bubble, and lets the API return the error to
-- programmatic callers (Shopify app etc.) without a Meta round-trip.
--
-- All three columns are nullable — every non-failed message has null
-- for all of them. `error_code` is TEXT rather than INTEGER so we can
-- store non-numeric codes (Meta hasn't done this yet but their docs
-- reserve the possibility for platform-side errors).
--
-- No index — errors are read alongside the parent message via the
-- primary key or by conversation_id (both already indexed). A
-- separate index on error_code would only pay off for "list every
-- failure by code" analytics we don't do yet.
--
-- Idempotent: safe to re-apply.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS error_code    TEXT,
  ADD COLUMN IF NOT EXISTS error_title   TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT;
