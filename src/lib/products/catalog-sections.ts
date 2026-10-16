import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProductVariant } from './types'

// ============================================================
// Shared "build the sections of a WhatsApp Multi-Product Message".
// Used by both the send_product_catalog AI tool AND the
// re-engagement cron.
//
// Every active product goes in (up to Meta's 30), grouped into one
// section per Shopify product type ("Honey", "Ghee") so the
// customer sees the range by category. Biggest category first;
// products with no type land in a trailing "More products".
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
const META_MAX_SECTIONS = 10
const META_SECTION_TITLE_MAX = 24
const UNCATEGORISED = 'More products'

interface ProductRow {
  shop_product_id: string
  variants?: ProductVariant[] | null
  title: string
  image_url?: string | null
  price_min?: number | null
  product_type?: string | null
}

/**
 * Per-product metadata keyed by retailer_id — what the inbox needs
 * to render the sent catalog bubble (title/price/image).
 */
export interface CatalogPreviewMeta {
  title: string | null
  price: number | null
  currency: string | null
  imageUrl: string | null
}

export interface CatalogSection {
  title: string
  productRetailerIds: string[]
}

export interface ProductCatalog {
  /** All retailer_ids, flattened in section order. */
  retailerIds: string[]
  sections: CatalogSection[]
  meta: Record<string, CatalogPreviewMeta>
}

export async function buildProductCatalogRetailerIds(
  db: SupabaseClient,
  accountId: string,
  maxProducts = META_MAX_PRODUCTS,
): Promise<string[]> {
  const { retailerIds } = await buildProductCatalog(db, accountId, maxProducts)
  return retailerIds
}

export async function buildProductCatalog(
  db: SupabaseClient,
  accountId: string,
  maxProducts = META_MAX_PRODUCTS,
): Promise<ProductCatalog> {
  const { data, error } = await db
    .from('products')
    .select('shop_product_id, variants, title, image_url, price_min, product_type')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('title', { ascending: true })
  if (error) {
    console.warn('[catalog-sections] product query failed:', error)
    return { retailerIds: [], sections: [], meta: {} }
  }
  return groupCatalogSections(
    (data ?? []) as ProductRow[],
    maxProducts,
    process.env.WHATSAPP_CATALOG_RETAILER_ID_PREFIX ?? '',
  )
}

/** Pure grouping step of buildProductCatalog — rows arrive title-sorted. */
export function groupCatalogSections(
  rows: ProductRow[],
  maxProducts = META_MAX_PRODUCTS,
  prefix = '',
): ProductCatalog {
  const limit = Math.max(1, Math.min(maxProducts, META_MAX_PRODUCTS))
  const meta: Record<string, CatalogPreviewMeta> = {}
  const groups = new Map<string, string[]>()

  for (const p of rows) {
    const variants = Array.isArray(p.variants) ? p.variants : []
    const cheapest = [...variants]
      .filter((v) => v && v.id)
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0]
    if (!cheapest?.id) continue
    const retailerId = `${prefix}${cheapest.id}`
    if (meta[retailerId]) continue
    meta[retailerId] = {
      title: p.title ?? null,
      price: cheapest.price ?? p.price_min ?? null,
      currency: 'INR',
      imageUrl: p.image_url ?? null,
    }
    const title =
      (p.product_type ?? '').trim().slice(0, META_SECTION_TITLE_MAX) || UNCATEGORISED
    const ids = groups.get(title) ?? []
    ids.push(retailerId)
    groups.set(title, ids)
  }

  let ordered = [...groups.entries()]
    .map(([title, productRetailerIds]) => ({ title, productRetailerIds }))
    .sort((a, b) => {
      if (a.title === UNCATEGORISED) return 1
      if (b.title === UNCATEGORISED) return -1
      return (
        b.productRetailerIds.length - a.productRetailerIds.length ||
        a.title.localeCompare(b.title)
      )
    })

  // Meta allows 10 sections — fold the overflow into one tail section.
  if (ordered.length > META_MAX_SECTIONS) {
    const kept = ordered.slice(0, META_MAX_SECTIONS - 1)
    const rest = ordered.slice(META_MAX_SECTIONS - 1)
    ordered = [
      ...kept,
      { title: UNCATEGORISED, productRetailerIds: rest.flatMap((s) => s.productRetailerIds) },
    ]
  }

  const sections: CatalogSection[] = []
  let remaining = limit
  for (const s of ordered) {
    if (remaining <= 0) break
    const ids = s.productRetailerIds.slice(0, remaining)
    sections.push({ title: s.title, productRetailerIds: ids })
    remaining -= ids.length
  }

  const retailerIds = sections.flatMap((s) => s.productRetailerIds)
  const total = ordered.reduce((n, s) => n + s.productRetailerIds.length, 0)
  if (total > retailerIds.length) {
    console.warn(
      `[catalog-sections] ${total} sendable products but the message holds ${retailerIds.length}; ${total - retailerIds.length} left out`,
    )
  }
  for (const id of Object.keys(meta)) {
    if (!retailerIds.includes(id)) delete meta[id]
  }
  return { retailerIds, sections, meta }
}
