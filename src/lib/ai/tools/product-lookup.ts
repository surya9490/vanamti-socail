import type { AiTool } from './registry'

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
// ============================================================

const MAX_RESULTS = 5

interface ProductRow {
  title: string
  price_min: number | null
  price_max: number | null
  currency: string | null
  product_url: string | null
}

function formatPrice(row: ProductRow): string {
  const symbol = row.currency === 'INR' ? '₹' : (row.currency || '')
  if (row.price_min == null && row.price_max == null) return ''
  if (row.price_min != null && row.price_max != null && row.price_min !== row.price_max) {
    return ` — ${symbol}${row.price_min}–${symbol}${row.price_max}`
  }
  const p = row.price_min ?? row.price_max
  return ` — ${symbol}${p}`
}

function formatRow(row: ProductRow): string {
  const url = row.product_url ? ` (${row.product_url})` : ''
  return `• ${row.title}${formatPrice(row)}${url}`
}

export const productLookupTool: AiTool = {
  name: 'product_lookup',
  label: 'Product catalogue lookup',
  description:
    'Look up products from the live store catalogue. Call this whenever the customer asks about products, prices, or "what do you sell". ' +
    'Pass a search term if the customer mentioned one (e.g. "honey", "gift box"); omit the query to get a small selection of active products for a generic greeting. ' +
    'Returns up to 5 products with prices — quote these verbatim rather than inventing numbers.',
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
      .select('title, price_min, price_max, currency, product_url')
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
