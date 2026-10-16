// ============================================================
// Shopify collections the WhatsApp catalog groups products by —
// the ones marked custom.wacrm = true, read live from the Vanamati
// app's GET /api/catalog-collections.
//
// Cached in memory for a few minutes: the catalog goes out on most
// greetings, and a collection flag changes rarely. If the app is
// down we reuse the last good answer; with none, callers fall back
// to grouping by product type.
//
// Config: VANAMATI_APP_URL + VANAMATI_ORDER_STATUS_KEY (the shared
// WACRM→Vanamati key, same as get_active_offers).
// ============================================================

export interface CatalogCollection {
  id: string
  title: string
  /** Numeric Shopify product ids (= products.shop_product_id), in the collection's sort order. */
  productIds: string[]
}

const CACHE_MS = 5 * 60_000
const TIMEOUT_MS = 4_000

let cached: { at: number; collections: CatalogCollection[] } | null = null

/** Test hook. */
export function resetCatalogCollectionsCache(): void {
  cached = null
}

export async function fetchCatalogCollections(): Promise<CatalogCollection[] | null> {
  const baseUrl = (process.env.VANAMATI_APP_URL || '').replace(/\/$/, '')
  const apiKey = process.env.VANAMATI_ORDER_STATUS_KEY || ''
  if (!baseUrl || !apiKey) return null
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.collections

  try {
    const res = await fetch(`${baseUrl}/api/catalog-collections`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as {
      collections?: Array<{ id?: unknown; title?: unknown; product_ids?: unknown }>
    }
    if (!Array.isArray(body.collections)) throw new Error('no collections[] in response')
    const collections = body.collections
      .filter((c) => typeof c.id === 'string' && typeof c.title === 'string' && c.title.trim())
      .map((c) => ({
        id: c.id as string,
        title: (c.title as string).trim(),
        productIds: Array.isArray(c.product_ids)
          ? c.product_ids.filter((p): p is string => typeof p === 'string')
          : [],
      }))
    cached = { at: Date.now(), collections }
    return collections
  } catch (err) {
    console.warn(
      '[catalog-collections] fetch failed:',
      err instanceof Error ? err.message : err,
    )
    return cached?.collections ?? null
  }
}
