import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProductVariant } from './types'

// ============================================================
// Shared "build product_retailer_ids for a WhatsApp Multi-Product
// Message". Used by both the send_product_catalog AI tool AND
// the re-engagement cron.
//
// Meta's Shopify Commerce sync creates one catalog entry per
// VARIANT, so product_retailer_id must be a variant id (Content
// ID) — a product-level id (Group ID) is rejected with #131009.
// We pick the cheapest variant per product as the entry point;
// on tap the customer sees the whole product page and can pick
// other sizes.
//
// WHATSAPP_CATALOG_RETAILER_ID_PREFIX env is honored for
// deployments whose catalog uses a prefixed retailer_id format
// (e.g. "shopify_IN_...").
// ============================================================

const META_MAX_PRODUCTS = 30

interface ProductRow {
  shop_product_id: string
  variants?: ProductVariant[] | null
  title: string
}

export async function buildProductCatalogRetailerIds(
  db: SupabaseClient,
  accountId: string,
  maxProducts = META_MAX_PRODUCTS,
): Promise<string[]> {
  const limit = Math.max(1, Math.min(maxProducts, META_MAX_PRODUCTS))
  const { data, error } = await db
    .from('products')
    .select('shop_product_id, variants, title')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('title', { ascending: true })
    .limit(limit)
  if (error) {
    console.warn('[catalog-sections] product query failed:', error)
    return []
  }
  const rows = (data ?? []) as ProductRow[]
  const prefix = process.env.WHATSAPP_CATALOG_RETAILER_ID_PREFIX ?? ''
  return rows
    .map((p) => {
      const variants = Array.isArray(p.variants) ? p.variants : []
      const cheapest = [...variants]
        .filter((v) => v && v.id)
        .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0]
      return cheapest?.id ?? null
    })
    .filter((id): id is string => Boolean(id))
    .map((id) => `${prefix}${id}`)
}
