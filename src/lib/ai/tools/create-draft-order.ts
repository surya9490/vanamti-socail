import type { AiTool } from './registry'

// ============================================================
// create_draft_order tool — creates a real Shopify draft order via
// the Vanamati Shopify app and returns the invoice URL the customer
// pays at.
//
// This is the closing step of a chat sale: the model has quoted a
// product (from product_lookup), the customer agreed, and now the
// model collects delivery details, calls this tool, and hands the
// customer the Shopify checkout URL to complete payment.
//
// Design properties (mirrors order_lookup):
//   * Phone comes from ctx.contactPhone — NEVER from the model.
//     Otherwise a poisoned prompt could route a fake order to a
//     different customer's WhatsApp for confirmation.
//   * Idempotency is NOT built in — the tool creates a new draft on
//     every call. The prompt is responsible for confirming with the
//     customer before invoking, and the sender-side handler warns
//     on repeat calls in the same conversation via the cool-down.
//   * Errors return a friendly string; the model apologises and
//     offers the product URL as a fallback path to purchase.
//
// Config: VANAMATI_APP_URL + VANAMATI_ORDER_STATUS_KEY (reused —
// same secret authenticates ALL WACRM → Vanamati internal calls).
// Without them the tool returns UNAVAILABLE rather than throwing.
// ============================================================

const UNAVAILABLE =
  'The order-creation system is temporarily unavailable. Please share the product page link with the customer and ask them to check out on the website.'

function draftOrderConfigured(): boolean {
  return Boolean(
    process.env.VANAMATI_APP_URL && process.env.VANAMATI_ORDER_STATUS_KEY,
  )
}

function looksLikeIndianPincode(pincode: string): boolean {
  return /^\d{6}$/.test(pincode)
}

/**
 * Normalise a variant title for fuzzy comparison. Strips whitespace,
 * lowercases, and canonicalises common Indian-market volume aliases:
 * "1l" / "1litr" / "1 litre" → "1000ml"; "2l" → "2000ml". Enough
 * tolerance for how customers actually name sizes ("1litrr", "1 L",
 * "1 liter", "1lt"), plus how the model might paraphrase them.
 */
function normalizeVariantTitle(t: string): string {
  let s = t.toLowerCase().trim().replace(/\s+/g, '')
  // Common shorthand → grams / ml canonical form.
  s = s.replace(/(\d+)\s*litr(e|es|es|s|r|rs)?\b/g, (_m, n) => `${Number(n) * 1000}ml`)
  s = s.replace(/(\d+)\s*l\b/g, (_m, n) => `${Number(n) * 1000}ml`)
  s = s.replace(/(\d+)\s*ltr\b/g, (_m, n) => `${Number(n) * 1000}ml`)
  s = s.replace(/(\d+)\s*lt\b/g, (_m, n) => `${Number(n) * 1000}ml`)
  s = s.replace(/(\d+)\s*kg\b/g, (_m, n) => `${Number(n) * 1000}g`)
  return s
}

export const createDraftOrderTool: AiTool = {
  name: 'create_draft_order',
  label: 'Create draft order',
  description:
    'Create a Shopify draft order for the customer and return a payment link. ' +
    'Call as SOON as the customer confirms they want to buy a specific product (variant + quantity). ' +
    'Address fields are OPTIONAL — if the customer already shared their name and full address, pass them so the checkout is pre-filled; if not, call the tool with just product/variant/quantity and the customer will enter their address on the Shopify checkout page (which handles validation, autofill, and delivery serviceability). ' +
    'The tool returns a checkout URL — share the URL with the customer verbatim and tell them to complete payment there. ' +
    'Never claim the order is "placed" or "confirmed" — payment only completes when the customer pays at the URL.',
  parameters: {
    type: 'OBJECT',
    properties: {
      shop_product_id: {
        type: 'STRING',
        description:
          'The product id shown as [product_id: X] in the product_lookup output. Preferred when you have it. Can be omitted if you pass variant_id — the tool will look up the parent product from the variant.',
      },
      variant_id: {
        type: 'STRING',
        description:
          'The specific variant id from product_lookup (numeric string). Preferred when you have it. Required when the product has multiple variants unless you pass variant_title instead.',
      },
      variant_title: {
        type: 'STRING',
        description:
          "The variant's human-friendly title as the customer named it (e.g. '250ml', '500ml', '1000ml', '1L'). Use this when you know which variant the customer picked but don't have the variant_id handy — the tool will match by title against the product's variants. Case-insensitive; '1L' matches '1000ml' etc. Ignored when variant_id is passed.",
      },
      quantity: {
        type: 'INTEGER',
        description:
          'How many units of this variant the customer wants. Defaults to 1 if omitted.',
      },
      customer_name: {
        type: 'STRING',
        description:
          "Customer's full name for the shipping label. Optional — pass if collected, otherwise the customer enters it at Shopify checkout.",
      },
      address_line1: {
        type: 'STRING',
        description:
          'Street address line 1 (house/flat number, street). Optional — if omitted, the customer enters at checkout. If you pass any address field, pass all of address_line1 + city + state + pincode together.',
      },
      address_line2: {
        type: 'STRING',
        description:
          'Street address line 2 — landmark, apartment, area. Always optional.',
      },
      city: {
        type: 'STRING',
        description: 'Delivery city. Optional; see address_line1.',
      },
      state: {
        type: 'STRING',
        description:
          'Indian state (full name, not code). Optional; see address_line1.',
      },
      pincode: {
        type: 'STRING',
        description:
          '6-digit Indian postal PIN code. Optional; see address_line1. Must be exactly 6 digits if provided.',
      },
    },
    // Nothing strictly required — either shop_product_id OR variant_id
    // identifies the product, and the runtime handles the missing case
    // with a clear corrective error. Prevents the model from being
    // "trapped" by the schema when it forgot one identifier but knows
    // the other from earlier in the transcript.
    required: [],
  },
  async run(args, ctx) {
    if (!draftOrderConfigured()) return UNAVAILABLE

    // No phone on the contact → we don't stamp the order phone, but
    // the shipping address is still enough to place the order. Not
    // strictly a blocker.
    const phone = ctx.contactPhone ?? undefined

    const shopProductId =
      typeof args.shop_product_id === 'string' ? args.shop_product_id.trim() : ''
    const variantId =
      typeof args.variant_id === 'string' ? args.variant_id.trim() : ''
    const variantTitle =
      typeof args.variant_title === 'string' ? args.variant_title.trim() : ''
    const quantityRaw = args.quantity
    const quantity =
      typeof quantityRaw === 'number' && quantityRaw > 0
        ? Math.min(Math.floor(quantityRaw), 100)
        : 1
    const customerName =
      typeof args.customer_name === 'string' ? args.customer_name.trim() : ''
    const addressLine1 =
      typeof args.address_line1 === 'string' ? args.address_line1.trim() : ''
    const addressLine2 =
      typeof args.address_line2 === 'string' ? args.address_line2.trim() : ''
    const city = typeof args.city === 'string' ? args.city.trim() : ''
    const state = typeof args.state === 'string' ? args.state.trim() : ''
    const pincode = typeof args.pincode === 'string' ? args.pincode.trim() : ''

    if (!shopProductId && !variantId) {
      return 'Missing both shop_product_id and variant_id — call product_lookup to get the values (shown as [product_id: X] and [variant_id: Y] in the output) and re-call.'
    }

    // Partial address? Reject it — Shopify's checkout can pre-fill
    // NOTHING or ALL of it, but a half-filled address confuses the
    // customer at checkout ("why is my city there but not my state").
    // If the model got some fields but not all, ask for the rest
    // rather than sending a broken draft.
    const anyAddress = Boolean(
      addressLine1 || city || state || pincode || addressLine2,
    )
    const fullAddress = Boolean(addressLine1 && city && state && pincode)
    if (anyAddress && !fullAddress) {
      return 'Address is partial — either collect ALL of: address line 1, city, state, and 6-digit pincode; or omit the address entirely and let the customer fill it at Shopify checkout.'
    }
    if (fullAddress && !looksLikeIndianPincode(pincode)) {
      return `The pincode "${pincode}" doesn't look right — please ask for a valid 6-digit Indian PIN code.`
    }

    // Resolve the product. Prefer shop_product_id if given, but fall
    // back to a reverse-lookup from variant_id (variants are globally
    // unique in Shopify, and our variants JSONB has a GIN index that
    // makes `variants @> [{id: X}]` cheap). This means the model can
    // pass just variant_id when it knows the size but forgot the
    // product id — the tool self-heals instead of erroring.
    let product: { variants?: unknown; title?: string; is_active?: boolean } | null = null

    if (shopProductId) {
      const { data, error: productErr } = await ctx.db
        .from('products')
        .select('shop_product_id, variants, title, is_active')
        .eq('account_id', ctx.accountId)
        .eq('shop_product_id', shopProductId)
        .maybeSingle()
      if (productErr) {
        console.warn('[create_draft_order] product lookup failed:', productErr)
        return UNAVAILABLE
      }
      product = data as typeof product
    }

    // Fallback: shop_product_id absent OR didn't match a row → find
    // the parent product by variant_id via a JS scan of the active
    // catalogue.
    //
    // Prior implementation used .contains('variants', [{id:X}]) —
    // supabase-js's JSONB-array-of-object query pattern proved
    // finicky and returned errors we couldn't see. At Vanamati's
    // scale (~16 active products) the linear scan is O(N) with
    // trivial cost; graduate to a proper JSONB query only if the
    // catalogue grows past a few hundred rows.
    if (!product && variantId) {
      const { data: allProducts, error: scanErr } = await ctx.db
        .from('products')
        .select('shop_product_id, variants, title, is_active')
        .eq('account_id', ctx.accountId)
        .eq('is_active', true)
      if (scanErr) {
        console.warn(
          '[create_draft_order] active-catalogue scan failed:',
          scanErr,
        )
        return UNAVAILABLE
      }
      const found = (allProducts as Array<{
        shop_product_id?: string
        variants?: unknown
        title?: string
        is_active?: boolean
      }> | null)?.find((p) => {
        if (!Array.isArray(p.variants)) return false
        return (p.variants as Array<{ id?: string }>).some(
          (v) => v.id === variantId,
        )
      })
      product = (found as typeof product) ?? null
    }

    if (!product) {
      // Neither identifier resolved to a real row. Coach the model to
      // re-check product_lookup output rather than tell the customer
      // anything about "unavailable" (which they'd read as out-of-stock).
      return `Couldn't resolve product from shop_product_id="${shopProductId}" or variant_id="${variantId}". Call product_lookup again and copy the exact [product_id: X] and [variant_id: Y] values shown in the output — do NOT invent ids or use URL slugs.`
    }
    if (!(product as { is_active?: boolean }).is_active) {
      return `Product resolved but is currently inactive in the catalogue. Fall back to sharing the product URL and ask the customer to complete purchase on the website.`
    }
    // From here on, refer to the RESOLVED shop_product_id in error
    // messages — the caller might have passed only a variant_id.
    const resolvedShopProductId =
      (product as { shop_product_id?: string }).shop_product_id || shopProductId
    const variants = Array.isArray((product as { variants?: unknown }).variants)
      ? ((product as { variants: unknown[] }).variants as Array<{
          id?: string
          title?: string | null
        }>)
      : []

    let resolvedVariantId = variantId
    if (!resolvedVariantId) {
      if (variants.length === 0) {
        return `Product ${resolvedShopProductId} has no variant on file — try refreshing the catalogue backfill.`
      }
      if (variants.length === 1) {
        const only = variants[0]
        if (!only?.id) return UNAVAILABLE
        resolvedVariantId = only.id
      } else if (variantTitle) {
        // Multi-variant product + model gave us a title hint. Match
        // by fuzzy title (case-insensitive substring, both ways).
        // Handles "1L" → "1000ml", "250" → "250ml", "500 ml" →
        // "500ml", etc. — enough tolerance for how customers and
        // models actually write sizes.
        const wanted = normalizeVariantTitle(variantTitle)
        const matches = variants.filter((v) => {
          if (!v.title) return false
          const t = normalizeVariantTitle(v.title)
          return t === wanted || t.includes(wanted) || wanted.includes(t)
        })
        if (matches.length === 1 && matches[0].id) {
          resolvedVariantId = matches[0].id
        } else if (matches.length > 1) {
          // Ambiguous — pass a clear next-step for the MODEL. Never
          // shown to the customer; the model should list variants
          // to the customer and let them clarify.
          return `Variant title "${variantTitle}" matched multiple variants on ${resolvedShopProductId}. Ask the customer which specific size they want, then re-call with the exact variant_title or variant_id.`
        } else {
          // No fuzzy match — same treatment as no-variant-id.
          return `Couldn't match variant "${variantTitle}" on product ${resolvedShopProductId}. Call product_lookup for this product to see the exact variant titles, decide which one the customer wants, and re-call create_draft_order with variant_id or variant_title.`
        }
      } else {
        // Multi-variant + no title hint from the model. Tell the
        // model to look them up — this branch is a coding-side
        // hint for the model, never surfaced verbatim.
        return `Product ${resolvedShopProductId} has multiple variants. Call product_lookup for this product, decide the variant matching the customer's stated size/option, then re-call create_draft_order with variant_id or variant_title.`
      }
    } else {
      // Verify the model-supplied variant belongs to this product.
      const match = variants.find((v) => v.id === resolvedVariantId)
      if (!match) {
        return `Variant ${resolvedVariantId} isn't on product ${resolvedShopProductId}. Call product_lookup to get current variant ids for this product and re-call with the correct one.`
      }
    }

    const baseUrl = (process.env.VANAMATI_APP_URL || '').replace(/\/$/, '')
    const apiKey = process.env.VANAMATI_ORDER_STATUS_KEY || ''

    try {
      // Address is only included when the model provided a complete
      // one; a bare product+variant draft is valid (customer fills
      // address at Shopify checkout).
      const payload: Record<string, unknown> = {
        variant_id: resolvedVariantId,
        quantity,
        phone,
      }
      if (customerName) payload.customer_name = customerName
      if (fullAddress) {
        payload.address = {
          line1: addressLine1,
          line2: addressLine2 || null,
          city,
          state,
          pincode,
          country: 'India',
        }
      }
      const response = await fetch(`${baseUrl}/api/draft-orders/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        console.warn(
          `[create_draft_order] Vanamati ${response.status}:`,
          text.slice(0, 200),
        )
        return UNAVAILABLE
      }
      const body = (await response.json()) as {
        invoice_url?: string
      }
      if (!body.invoice_url) return UNAVAILABLE

      return `Draft order created. Share this payment link with the customer verbatim (do NOT claim the order is placed — payment happens on this page):\n\n${body.invoice_url}`
    } catch (err) {
      console.warn('[create_draft_order] fetch failed:', err)
      return UNAVAILABLE
    }
  },
}
