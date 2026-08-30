-- ============================================================
-- Migration 049 — variants column on products.
--
-- Adds per-variant detail (id, title, price, sku, availability) so
-- the AI can:
--   * surface size / weight / pack options in-chat ("250ml — ₹549,
--     500ml — ₹899") when the customer asks
--   * pass the correct variantId when creating a Shopify draft order
--     via the create_draft_order tool
--
-- Shape: JSONB array of { id, title, price, sku, is_available }.
-- Populated by the Vanamati Shopify app's product webhooks + the
-- backfill route (both updated in this PR).
--
-- Kept as JSONB rather than a separate `product_variants` table
-- because:
--   * variants are always read together with the parent product
--   * count per product is small (1-10 typical)
--   * no cross-product queries against variant fields are planned
--   * a normalised table would cost a JOIN on every product_lookup
--     with no analytical upside
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS variants JSONB NOT NULL DEFAULT '[]'::jsonb;

-- GIN index on the raw variants array — supports "which product has
-- variant id X" lookups from create_draft_order without a full scan.
CREATE INDEX IF NOT EXISTS idx_products_variants_gin
  ON products USING GIN (variants);
