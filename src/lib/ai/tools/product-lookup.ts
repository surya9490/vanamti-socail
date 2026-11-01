import type { AiTool } from './registry'
import type { ProductVariant } from '@/lib/products/types'

// ============================================================
// product_lookup tool — lets the AI answer product questions from
// the local product cache (populated by the Vanamati Shopify app
// via webhook + backfill; see migration 048).
//
// Prefer this over the KB for anything price-sensitive: the KB is
// scraped from the website (potentially stale), the cache mirrors
// the live Shopify catalogue (fresh within seconds of a change).
//
// Two invocation shapes:
//   * with a query   → up to 5 title/description matches (FTS)
//   * without a query → up to 5 active products (deterministic by
//     title so greetings surface the same picks reply-to-reply)
//
// Every returned line is one product formatted the way we want it
// to appear in the AI's reply — the model then quotes/paraphrases
// from that plain-text block rather than composing prices from
// scratch, so it can't invent numbers.
//
// When a product has multiple variants (250ml / 500ml / 1kg) we
// list them inline with their variant IDs so create_draft_order
// can be called with the right one. The variant ID is model-facing
// only — it never lands in a customer-facing message unless the
// model puts it there (which the prompt forbids).
// ============================================================

const MAX_RESULTS = 5

interface ProductRow {
  title: string
  shop_product_id: string
  price_min: number | null
  price_max: number | null
  currency: string | null
  product_url: string | null
  variants: unknown
}

function currencySymbol(currency: string | null): string {
  return currency === 'INR' ? '₹' : currency || ''
}

function formatPriceRange(row: ProductRow): string {
  const symbol = currencySymbol(row.currency)
  if (row.price_min == null && row.price_max == null) return ''
  if (
    row.price_min != null &&
    row.price_max != null &&
    row.price_min !== row.price_max
  ) {
    return ` — ${symbol}${row.price_min}–${symbol}${row.price_max}`
  }
  const p = row.price_min ?? row.price_max
  return ` — ${symbol}${p}`
}

function coerceVariants(raw: unknown): ProductVariant[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (v): v is ProductVariant =>
      !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string',
  )
}

// Shopify's availableForSale, mirrored by the Vanamati feed. A variant
// cached before the flag existed has no value — treat that as in stock.
function isSoldOut(v: ProductVariant): boolean {
  return v.is_available === false
}

function formatVariantLine(v: ProductVariant, currency: string | null): string {
  const label = v.title ?? 'default'
  const price = v.price != null ? ` — ${currencySymbol(currency)}${v.price}` : ''
  // No variant_id for a sold-out size: there's nothing to order.
  if (isSoldOut(v)) return `    - ${label}${price} — SOLD OUT`
  return `    - ${label}${price} [variant_id: ${v.id}]`
}

export function formatRow(row: ProductRow): string {
  const variants = coerceVariants(row.variants)

  // Every size sold out: no ids and no link, so the model has nothing
  // to sell from. Live 2026-11-01: the bot quoted Iyappa Ghee's three
  // sizes and its link while Shopify had all of them sold out.
  if (variants.length > 0 && variants.every(isSoldOut)) {
    return (
      `• ${row.title}${formatPriceRange(row)} — SOLD OUT (every size)` +
      `\n    (do NOT share the link or offer to order it — tell the customer it's out of stock, ` +
      `give the restock date if the knowledge base has one, and suggest an in-stock alternative)`
    )
  }

  // product_id is REQUIRED for the model to pass to create_draft_order.
  // Show it prominently in a labelled bracket — customer never sees the
  // tool output, so being verbose here is safe and it stops the model
  // from hallucinating IDs (which was happening — the model was
  // sometimes grabbing the URL slug or making up 13-digit numbers).
  const idTag = ` [product_id: ${row.shop_product_id}]`
  const url = row.product_url ? ` (${row.product_url})` : ''

  // Signals that this product is multi-variant even when we don't
  // have the variant array cached: a spread between price_min and
  // price_max means there are AT LEAST two SKUs at different prices.
  const priceRangeSuggestsMultiVariant =
    row.price_min != null &&
    row.price_max != null &&
    row.price_min !== row.price_max

  // Single variant on file (or none) but no price spread → simple
  // one-price product; render on one line with inline variant id
  // if we have it.
  if (variants.length <= 1 && !priceRangeSuggestsMultiVariant) {
    const solo = variants[0]
    const inlineVariantId = solo ? ` [variant_id: ${solo.id}]` : ''
    return `• ${row.title}${idTag}${formatPriceRange(row)}${url}${inlineVariantId}`
  }

  // Multi-variant with variant array populated → fan out per variant
  // so the model can pick the right one.
  if (variants.length > 1) {
    const header = `• ${row.title}${idTag}${url}`
    const varLines = variants
      .map((v) => formatVariantLine(v, row.currency))
      .join('\n')
    return `${header}\n${varLines}`
  }

  // Multi-variant per price range BUT variant array empty in cache.
  // This happens when the product feed was populated before the
  // Vanamati transformer started including variants — the operator
  // needs to re-run backfill. Signal this to the model so it can
  // fall back gracefully (share the product URL, ask customer to
  // choose on the site) instead of trying to create a draft it
  // has no variant data for.
  return (
    `• ${row.title}${idTag}${formatPriceRange(row)}${url}` +
    `\n    (variants not cached for this product — do NOT call create_draft_order; ` +
    `share the product URL and ask the customer to pick their size on the website)`
  )
}

export const productLookupTool: AiTool = {
  name: 'product_lookup',
  label: 'Product catalogue lookup',
  description:
    'Look up products from the live store catalogue — exact prices, sizes and variant ids for a SPECIFIC product the customer named, a cross-sell item, or create_draft_order. ' +
    'For browsing ("what do you sell", "show me", a category like "honey") use send_product_catalog instead — never paste this tool\'s output to the customer as a list of products. ' +
    'Pass a search term (e.g. "forest honey"); omitting it returns a small selection of active products. ' +
    'Returns up to 5 products with prices and (for multi-variant products) each variant with its variant_id. ' +
    'A size or product marked SOLD OUT cannot be ordered — never offer it or its link; offer an in-stock size or product instead. ' +
    'Quote titles + prices verbatim rather than inventing numbers. Never show variant_id values to the customer — they are for calling create_draft_order.',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: {
        type: 'STRING',
        description:
          "Optional keyword(s) the customer used, e.g. 'honey', 'gift'. Omit for a generic featured-products list.",
      },
    },
    required: [],
  },
  async run(args, ctx) {
    const raw = typeof args.query === 'string' ? args.query.trim() : ''

    let query = ctx.db
      .from('products')
      .select('title, shop_product_id, price_min, price_max, currency, product_url, variants')
      .eq('account_id', ctx.accountId)
      .eq('is_active', true)
      .limit(MAX_RESULTS)

    if (raw) {
      // Postgres FTS via the GENERATED `fts` column (migration 048)
      // and its GIN index. websearch_to_tsquery handles the natural-
      // language shape the model tends to produce ("raw honey small
      // jar") without requiring us to sanitise operators.
      query = query.textSearch('fts', raw, {
        type: 'websearch',
        config: 'simple',
      })
    } else {
      query = query.order('title', { ascending: true })
    }

    const { data, error } = await query
    if (error) {
      console.warn('[product_lookup] query failed:', error)
      return 'The product catalogue is temporarily unavailable.'
    }
    if (!data || data.length === 0) {
      return raw
        ? `No products matched "${raw}".`
        : 'The product catalogue is empty right now.'
    }

    return (data as ProductRow[]).map(formatRow).join('\n')
  },
}
