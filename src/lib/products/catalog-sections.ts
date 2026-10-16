import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProductVariant } from './types'
import { fetchCatalogCollections, type CatalogCollection } from './catalog-collections'

// ============================================================
// Shared "build the sections of a WhatsApp Multi-Product Message".
// Used by both the send_product_catalog AI tool AND the
// re-engagement cron.
//
// Every active product goes in (up to Meta's 30), one section per
// Shopify collection marked custom.wacrm = true (see
// catalog-collections), biggest first. A collection that holds
// every product ("All") is skipped — the list already is that. A
// product in two collections appears once, under the first; any
// product in none lands in a trailing "More products". With no
// usable collections (none flagged, Vanamati app unreachable), the
// sections fall back to one per Shopify product type.
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

interface Entry {
  retailerId: string
  productType: string | null
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
  const [{ data, error }, collections] = await Promise.all([
    db
      .from('products')
      .select('shop_product_id, variants, title, image_url, price_min, product_type')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .order('title', { ascending: true }),
    fetchCatalogCollections(),
  ])
  if (error) {
    console.warn('[catalog-sections] product query failed:', error)
    return { retailerIds: [], sections: [], meta: {} }
  }
  const rows = (data ?? []) as ProductRow[]
  const prefix = process.env.WHATSAPP_CATALOG_RETAILER_ID_PREFIX ?? ''
  return (
    (collections?.length
      ? groupByCollections(rows, collections, maxProducts, prefix)
      : null) ?? groupCatalogSections(rows, maxProducts, prefix)
  )
}

/**
 * Sections from the flagged Shopify collections. Null when none of
 * them gives a usable section, so the caller falls back to type.
 */
export function groupByCollections(
  rows: ProductRow[],
  collections: CatalogCollection[],
  maxProducts = META_MAX_PRODUCTS,
  prefix = '',
): ProductCatalog | null {
  const { entries, meta } = sendableEntries(rows, prefix)
  const candidates = collections
    .map((c) => ({
      title: sectionTitle(c.title),
      ids: [...new Set(c.productIds)].filter((id) => entries.has(id)),
    }))
    .filter((c) => c.ids.length > 0 && c.ids.length < entries.size)
    .sort((a, b) => b.ids.length - a.ids.length || a.title.localeCompare(b.title))
  if (candidates.length === 0) return null

  const used = new Set<string>()
  const sections: CatalogSection[] = []
  for (const c of candidates) {
    const ids = c.ids.filter((id) => !used.has(id))
    for (const id of ids) used.add(id)
    if (ids.length) {
      sections.push({
        title: c.title,
        productRetailerIds: ids.map((id) => entries.get(id)!.retailerId),
      })
    }
  }
  const rest = [...entries.keys()].filter((id) => !used.has(id))
  if (rest.length) {
    sections.push({
      title: UNCATEGORISED,
      productRetailerIds: rest.map((id) => entries.get(id)!.retailerId),
    })
  }
  return finalize(sections, maxProducts, meta)
}

/** Sections by Shopify product type — the fallback. Rows arrive title-sorted. */
export function groupCatalogSections(
  rows: ProductRow[],
  maxProducts = META_MAX_PRODUCTS,
  prefix = '',
): ProductCatalog {
  const { entries, meta } = sendableEntries(rows, prefix)
  const groups = new Map<string, string[]>()
  for (const e of entries.values()) {
    const title = sectionTitle(e.productType ?? '') || UNCATEGORISED
    const ids = groups.get(title) ?? []
    ids.push(e.retailerId)
    groups.set(title, ids)
  }
  const ordered = [...groups.entries()]
    .map(([title, productRetailerIds]) => ({ title, productRetailerIds }))
    .sort((a, b) => {
      if (a.title === UNCATEGORISED) return 1
      if (b.title === UNCATEGORISED) return -1
      return (
        b.productRetailerIds.length - a.productRetailerIds.length ||
        a.title.localeCompare(b.title)
      )
    })
  return finalize(ordered, maxProducts, meta)
}

function sectionTitle(raw: string): string {
  return raw.trim().slice(0, META_SECTION_TITLE_MAX)
}

/** Products we can send, keyed by shop_product_id, with their cheapest variant. */
function sendableEntries(
  rows: ProductRow[],
  prefix: string,
): { entries: Map<string, Entry>; meta: Record<string, CatalogPreviewMeta> } {
  const entries = new Map<string, Entry>()
  const meta: Record<string, CatalogPreviewMeta> = {}
  for (const p of rows) {
    const variants = Array.isArray(p.variants) ? p.variants : []
    const cheapest = [...variants]
      .filter((v) => v && v.id)
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0]
    if (!cheapest?.id) continue
    const retailerId = `${prefix}${cheapest.id}`
    if (meta[retailerId] || entries.has(p.shop_product_id)) continue
    meta[retailerId] = {
      title: p.title ?? null,
      price: cheapest.price ?? p.price_min ?? null,
      currency: 'INR',
      imageUrl: p.image_url ?? null,
    }
    entries.set(p.shop_product_id, { retailerId, productType: p.product_type ?? null })
  }
  return { entries, meta }
}

/** Apply Meta's 10-section and 30-product limits; drop meta for what got cut. */
function finalize(
  ordered: CatalogSection[],
  maxProducts: number,
  meta: Record<string, CatalogPreviewMeta>,
): ProductCatalog {
  const limit = Math.max(1, Math.min(maxProducts, META_MAX_PRODUCTS))
  let grouped = ordered
  if (grouped.length > META_MAX_SECTIONS) {
    const kept = grouped.slice(0, META_MAX_SECTIONS - 1)
    const rest = grouped.slice(META_MAX_SECTIONS - 1)
    grouped = [
      ...kept,
      { title: UNCATEGORISED, productRetailerIds: rest.flatMap((s) => s.productRetailerIds) },
    ]
  }

  const sections: CatalogSection[] = []
  let remaining = limit
  for (const s of grouped) {
    if (remaining <= 0) break
    const ids = s.productRetailerIds.slice(0, remaining)
    sections.push({ title: s.title, productRetailerIds: ids })
    remaining -= ids.length
  }

  const retailerIds = sections.flatMap((s) => s.productRetailerIds)
  const total = grouped.reduce((n, s) => n + s.productRetailerIds.length, 0)
  if (total > retailerIds.length) {
    console.warn(
      `[catalog-sections] ${total} sendable products but the message holds ${retailerIds.length}; ${total - retailerIds.length} left out`,
    )
  }
  const kept = new Set(retailerIds)
  const keptMeta: Record<string, CatalogPreviewMeta> = {}
  for (const id of kept) keptMeta[id] = meta[id]
  return { retailerIds, sections, meta: keptMeta }
}
