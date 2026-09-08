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
  image_url?: string | null
  price_min?: number | null
}

export async function buildProductCatalogRetailerIds(
  db: SupabaseClient,
  accountId: string,
  maxProducts = META_MAX_PRODUCTS,
): Promise<string[]> {
  const { retailerIds } = await buildProductCatalog(db, accountId, maxProducts)
  return retailerIds
}

/**
 * Enriched variant of buildProductCatalogRetailerIds — returns both
 * the retailer_ids (what Meta needs) AND a metadata map keyed by
 * those retailer_ids (title/price/image, what the inbox needs to
 * render the sent catalog bubble). Same product picking rules.
 */
export interface CatalogPreviewMeta {
  title: string | null
  price: number | null
  currency: string | null
  imageUrl: string | null
}

export async function buildProductCatalog(
  db: SupabaseClient,
  accountId: string,
  maxProducts = META_MAX_PRODUCTS,
): Promise<{
  retailerIds: string[]
  meta: Record<string, CatalogPreviewMeta>
}> {
  const limit = Math.max(1, Math.min(maxProducts, META_MAX_PRODUCTS))
  const { data, error } = await db
    .from('products')
    .select('shop_product_id, variants, title, image_url, price_min')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('title', { ascending: true })
    .limit(limit)
  if (error) {
    console.warn('[catalog-sections] product query failed:', error)
    return { retailerIds: [], meta: {} }
  }
  const rows = (data ?? []) as ProductRow[]
  const prefix = process.env.WHATSAPP_CATALOG_RETAILER_ID_PREFIX ?? ''
  const retailerIds: string[] = []
  const meta: Record<string, CatalogPreviewMeta> = {}
  for (const p of rows) {
    const variants = Array.isArray(p.variants) ? p.variants : []
    const cheapest = [...variants]
      .filter((v) => v && v.id)
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0]
    if (!cheapest?.id) continue
    const retailerId = `${prefix}${cheapest.id}`
    retailerIds.push(retailerId)
    meta[retailerId] = {
      title: p.title ?? null,
      price: cheapest.price ?? p.price_min ?? null,
      currency: 'INR',
      imageUrl: p.image_url ?? null,
    }
  }
  return { retailerIds, meta }
}
