-- ============================================================
-- 043_ai_knowledge_fts_or.sql — lenient lexical knowledge retrieval
--
-- `match_ai_knowledge_fts` used `plainto_tsquery`, which ANDs every word
-- in the customer's question. So "what is the price of acacia honey"
-- required a single chunk containing ALL of {what,is,the,price,of,acacia,
-- honey} — and matched nothing, so the assistant had no context and
-- handed off even when the answer was in the knowledge base.
--
-- Fix: turn the AND query into an OR query (swap `&` → `|` in the parsed
-- tsquery), so a chunk matching ANY of the meaningful terms is retrieved,
-- with `ts_rank` still surfacing the most relevant chunk first. This is
-- the difference between "no results" and "the acacia price row" for a
-- natural-language question. Especially important for accounts on lexical
-- search only (no embeddings key, e.g. Gemini-only setups).
--
-- Keeps the `'simple'` config (must match the stored `fts` tsvector's
-- config) and the SECURITY INVOKER / signature from migration 034.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  WITH q AS (
    -- plainto_tsquery joins terms with `&` (AND). Swap to `|` (OR) so any
    -- meaningful term matches; NULLIF guards the all-stopwords/empty case.
    SELECT NULLIF(
             replace(plainto_tsquery('simple', p_query)::text, '&', '|'),
             ''
           )::tsquery AS query
  )
  SELECT c.id,
         c.content,
         ts_rank(c.fts, q.query) AS rank
  FROM ai_knowledge_chunks c, q
  WHERE q.query IS NOT NULL
    AND c.account_id = p_account_id
    AND c.fts @@ q.query
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;
