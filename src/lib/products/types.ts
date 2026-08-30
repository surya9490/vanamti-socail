// ============================================================
// Product cache — types shared between the webhook, backfill, and
// AI tool. Matches the shape of the `products` row (migration 048)
// after camelCasing the columns.
// ============================================================

/**
 * A single variant of a product. The `id` is Shopify's variantId in
 * the shape create_draft_order needs to pass back for the
 * draftOrderCreate mutation — either a bare numeric ("12345") or a
 * GID ("gid://shopify/ProductVariant/12345"), whichever Vanamati
 * sent. `is_available` mirrors Shopify's inventory availability but
 * per operator preference is not gated on for chat sales.
 */
export interface ProductVariant {
  id: string
  title: string | null
  price: number | null
  sku: string | null
  is_available: boolean
}

/**
 * A single product as stored in the WACRM cache. Mirrors what the
 * Vanamati Shopify app sends via webhook, minus columns that only
 * matter server-side (created_at, account_id).
 */
export interface Product {
  id: string
  shopProductId: string
  handle: string | null
  title: string
  description: string | null
  priceMin: number | null
  priceMax: number | null
  currency: string
  productUrl: string | null
  imageUrl: string | null
  tags: string[]
  productType: string | null
  isActive: boolean
  variants: ProductVariant[]
  syncedAt: string
}

/**
 * The payload the Vanamati app posts for one product event. `event`
 * decides whether we upsert or soft-delete. On 'deleted' we still
 * expect at least `shop_product_id` — the other fields may be null.
 *
 * Note there's NO account_id on the wire: the target account is
 * resolved from the `WACRM_API_KEY` (via requireApiKey). Sending an
 * account_id in the body would just be ignored, and letting a key
 * push into a different account would defeat per-account isolation.
 */
export interface ProductWebhookPayload {
  event: 'created' | 'updated' | 'deleted'
  product: {
    shop_product_id: string
    handle?: string | null
    title?: string | null
    description?: string | null
    price_min?: number | null
    price_max?: number | null
    currency?: string | null
    product_url?: string | null
    image_url?: string | null
    tags?: string[] | null
    product_type?: string | null
    is_active?: boolean | null
    variants?: ProductVariant[] | null
  }
}

/**
 * Bulk-backfill payload — one call carries the whole (paginated)
 * catalogue. Batch-sized on the sender side (Vanamati app) to stay
 * under request-body limits; here we just upsert whatever arrives.
 * Target account comes from the API key, same as the streaming
 * webhook payload.
 */
export interface ProductBackfillPayload {
  products: ProductWebhookPayload['product'][]
}
