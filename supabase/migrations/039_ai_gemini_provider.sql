-- ============================================================
-- 039_ai_gemini_provider.sql — allow Gemini as an AI provider
--
-- Widens the `ai_configs.provider` CHECK to accept 'gemini' alongside
-- the existing 'openai' / 'anthropic'. The original inline constraint in
-- 031_ai_reply.sql was unnamed, so Postgres auto-named it
-- `ai_configs_provider_check`; drop that (IF EXISTS) and re-add a named
-- constraint so future edits are explicit.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));
