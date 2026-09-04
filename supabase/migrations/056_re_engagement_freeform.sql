-- ============================================================
-- Migration 056 — free-tier stages inside the 24h session window.
--
-- Silence < 24h means the customer's WhatsApp session is still
-- open, so we can send freeform text or a Multi-Product Message
-- (catalog) — no template, no MARKETING cost. This migration
-- widens the type enum to add those two options and adds a
-- nullable custom_text column for the freeform body.
--
-- New allowed values on template_type:
--   'text'          — Meta text template (any time, params must
--                     already be zero — see cron)
--   'carousel'      — Meta carousel template (any time)
--   'catalog'       — Path A Multi-Product Message (in-session
--                     only, hours_after < 24, FREE)
--   'freeform_text' — plain text send (in-session only,
--                     hours_after < 24, FREE); body comes from
--                     the new custom_text column.
--
-- The in-session-only invariant is enforced BY THE API on write
-- (not by a DB constraint) — Postgres can't cheaply express
-- "template_type in (catalog, freeform_text) → hours_after < 24"
-- with the existing check-constraint shape, and it's a
-- write-path check anyway. Cron enforces it defensively too.
-- ============================================================

ALTER TABLE re_engagement_stages
  DROP CONSTRAINT IF EXISTS re_engagement_stages_template_type_check;

ALTER TABLE re_engagement_stages
  ADD CONSTRAINT re_engagement_stages_template_type_check
  CHECK (template_type IN ('text', 'carousel', 'catalog', 'freeform_text'));

ALTER TABLE re_engagement_stages
  ADD COLUMN IF NOT EXISTS custom_text TEXT;

-- template_name is only meaningful for the two template types;
-- for 'catalog' and 'freeform_text' it's ignored. Left NOT NULL
-- (existing rows have it) to avoid a data-migration; the API
-- stores an empty string when the type doesn't need it.
