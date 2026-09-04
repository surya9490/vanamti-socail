import type { SupabaseClient } from '@supabase/supabase-js'
import type { CarouselCard } from '@/lib/whatsapp/meta-api'
import type { ProductVariant } from './types'

// ============================================================
// Shared "build product cards for a Meta Carousel template".
//
// Used by both the send_product_carousel AI tool AND the
// re-engagement cron. Pulls active products with images from the
// account's cache and maps each to a CarouselCard matching the
// pre-approved template's variable layout:
//
//   Template body:      "Hi {{1}}!..."      → filled by caller
//   Card body:          "{{1}} — from ₹{{2}}"  ← (product title, price)
//   Card URL button:    ".../products/{{1}}"   ← (product handle)
//
// Filters:
//   * account_id matches
//   * is_active = true
//   * image_url is present (carousel cards REQUIRE an image URL)
//
// Returns 2–maxCards items. Fewer than 2 → returns empty array
// (Meta rejects carousels with <2 cards).
// ============================================================

interface ProductRow {
  shop_product_id: string
  handle: string | null
  title: string
  price_min: number | null
  image_url: string | null
  variants?: ProductVariant[] | null
}

const META_MAX_CARDS = 10

export async function buildProductCarouselCards(
  db: SupabaseClient,
  accountId: string,
  maxCards = META_MAX_CARDS,
): Promise<CarouselCard[]> {
  const limit = Math.max(1, Math.min(maxCards, META_MAX_CARDS))

  const { data, error } = await db
    .from('products')
    .select('shop_product_id, handle, title, price_min, image_url, variants')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .not('image_url', 'is', null)
    .order('title', { ascending: true })
    .limit(limit)
  if (error) {
    console.warn('[carousel-cards] product query failed:', error)
    return []
  }

  const rows = (data ?? []) as ProductRow[]
  const cards = rows
    .filter((p) => p.image_url && p.title)
    .map((p) => ({
      imageUrl: p.image_url!,
      bodyParams: [p.title, String(p.price_min ?? '')],
      buttonUrlSuffixes: [p.handle ?? ''],
    }))

  // Meta requires 2-10 cards. If we have fewer than 2 products
  // with images, caller falls back to text.
  return cards.length >= 2 ? cards : []
}
