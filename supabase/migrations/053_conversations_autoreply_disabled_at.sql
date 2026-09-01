-- ============================================================
-- Migration 053 — track WHEN auto-reply was disabled.
--
-- Adds ai_autoreply_disabled_at so the AI dispatcher can decide
-- to auto-resume after a configurable idle window (default 24h).
--
-- Why: a customer may return to a handed-off conversation days
-- later with a completely different question ("where's my
-- order?"). Without auto-resume, they get silence until an agent
-- manually clicks Resume AI. The 24h idle window is picked to
-- match the WhatsApp session window — a fresh window means a
-- fresh customer intent, and the AI should try to help again.
--
-- Human agents can still manually pause (Take over) or resume
-- (Resume AI); this only changes the "AI paused for a long time
-- and a new customer message arrived" case.
--
-- Backfill: NULL for existing rows means "we don't know when
-- this was paused" — the auto-resume logic treats NULL the same
-- as "long enough ago" and auto-resumes, matching the operator's
-- likely intent for stale handoffs.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_autoreply_disabled_at TIMESTAMPTZ;

-- No index needed — the column is only read as part of the
-- auto-reply eligibility check on ONE conversation at a time,
-- always keyed by the already-indexed id.
