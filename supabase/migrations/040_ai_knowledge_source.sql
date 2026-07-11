-- ============================================================
-- 040_ai_knowledge_source.sql — provenance for knowledge documents
--
-- Adds where-a-doc-came-from metadata so the website crawler can:
--   - tag imported docs (`source_type = 'website'`) for a UI badge, and
--   - re-crawl idempotently: a partial UNIQUE(account_id, source_url)
--     lets the importer UPDATE the existing doc for a page instead of
--     inserting a duplicate every run.
--
-- Existing rows (pasted by hand) default to `source_type = 'manual'`
-- with a NULL source_url, so they're excluded from the unique index.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_url  text;

ALTER TABLE ai_knowledge_documents
  DROP CONSTRAINT IF EXISTS ai_knowledge_documents_source_type_check;
ALTER TABLE ai_knowledge_documents
  ADD CONSTRAINT ai_knowledge_documents_source_type_check
  CHECK (source_type IN ('manual', 'website'));

-- One document per (account, crawled URL). Partial so hand-authored docs
-- (NULL source_url) are never in conflict with each other.
CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_documents_account_source_url_uniq
  ON ai_knowledge_documents (account_id, source_url)
  WHERE source_url IS NOT NULL;
