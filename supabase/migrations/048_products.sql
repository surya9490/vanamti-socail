-- ============================================================
-- Migration 048 — products cache table.
--
-- Local mirror of the store's product catalogue. Populated by the
-- Vanamati Shopify app: every products/create, products/update,
-- products/delete webhook (registered inside the app) triggers a
-- signed POST to /api/webhooks/vanamati/products, which upserts /
-- soft-deletes rows here. On cold-start, /api/backfill/products
-- takes a bulk push of the full catalogue.
--
-- Why cache locally instead of calling the app live at reply time:
--   * Zero latency in the auto-reply path (no external HTTP hop)
--   * Full catalogue available for KB retrieval and semantic search
--   * AI still works if the Shopify app is briefly down
--
-- Writes go through the service role only (webhook endpoints).
-- Reads are open to any account member so the settings UI can
-- render the cached catalogue.
-- ============================================================

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- Shopify's product id; the upsert key together with account_id.
  shop_product_id TEXT NOT NULL,

  -- Shopify handle (used to build the product URL if we don't get one).
  handle TEXT,

  title TEXT NOT NULL,
  -- Plain-text description. HTML/rich text is stripped upstream
  -- (Vanamati app transforms Shopify's body_html before POSTing).
  description TEXT,

  -- Prices are per-variant in Shopify; we store the range so the AI
  -- can say "from ₹450" or "₹450–₹1200" without needing variant detail.
  price_min NUMERIC(12,2),
  price_max NUMERIC(12,2),
  currency TEXT DEFAULT 'INR',

  -- Canonical URL on the storefront (e.g. https://vanamati.com/products/raw-honey).
  product_url TEXT,
  image_url TEXT,

  tags TEXT[] DEFAULT '{}',
  product_type TEXT,

  -- Shopify sends product events for both published and unpublished
  -- products; is_active mirrors "should we surface this to customers".
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Full-text search vector maintained by Postgres. Same GENERATED
  -- STORED pattern as ai_knowledge_chunks.fts (migration 032).
  --
  -- Only title + description are folded in: array_to_string() over
  -- tags is STABLE (not IMMUTABLE) in this Postgres version, and
  -- GENERATED columns require an IMMUTABLE expression. Tag search
  -- can filter separately via the tags array (== any / && operators),
  -- and product titles usually contain the relevant keywords anyway
  -- ("Raw Honey 500g", "Kashmiri Almonds") so the trade is small.
  fts TSVECTOR GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce(title, '') || ' ' || coalesce(description, '')
    )
  ) STORED,

  UNIQUE (account_id, shop_product_id)
);

CREATE INDEX IF NOT EXISTS idx_products_account_active
  ON products(account_id, is_active);

CREATE INDEX IF NOT EXISTS idx_products_fts
  ON products USING GIN (fts);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

-- Readable by any account member (owner / admin / agent / viewer).
DROP POLICY IF EXISTS "Account members can read products" ON products;
CREATE POLICY "Account members can read products"
  ON products FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

-- No INSERT / UPDATE / DELETE policies: writes go through the
-- service-role webhook endpoints, which bypass RLS. Client code can
-- never mutate this table directly, so a stale token or an XSS on
-- the dashboard can't corrupt the catalogue.
