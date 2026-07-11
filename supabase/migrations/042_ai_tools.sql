-- ============================================================
-- 042_ai_tools.sql — per-account AI tool allow-list
--
-- Adds `enabled_tools` to `ai_configs`: the names of the function-calling
-- tools (from the code-side tool registry, e.g. 'order_lookup') this
-- account has switched on. Empty array = the assistant answers with text
-- only. Only tools present in the registry are ever exposed to the model,
-- and only those an admin has listed here — a two-layer allow-list.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS enabled_tools text[] NOT NULL DEFAULT '{}';
