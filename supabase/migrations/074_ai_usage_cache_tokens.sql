-- ============================================================
-- Migration 074 — prompt-cache tokens on ai_usage_log.
--
-- Anthropic bills cached prompt tokens apart from input_tokens:
-- cache writes at 1.25x the input price, cache reads at 0.1x.
-- prompt_tokens only ever held input_tokens, so the Usage tab
-- showed about a sixth of October 2026's real spend — the ~10K-token
-- system prompt written to the cache on every reply never appeared.
--
-- total_tokens keeps its meaning (prompt + completion): the
-- per-contact daily cap in auto-reply sums it. Existing rows get 0.
-- ============================================================

ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER NOT NULL DEFAULT 0;
