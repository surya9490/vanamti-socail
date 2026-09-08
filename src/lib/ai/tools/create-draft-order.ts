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

interface LineItemArg {
  shop_product_id?: unknown
  variant_id?: unknown
  variant_title?: unknown
  quantity?: unknown
}

type ResolvedLineItem = { variant_id: string; quantity: number }

/**
 * Resolve one line-item spec (shop_product_id / variant_id /
 * variant_title / quantity) to a definite {variant_id, quantity}.
 * Uses the same product+variant matching rules as the single-item
 * path — extracted so both paths share exactly one resolver.
 *
 * Returns a string on any error (matches the tool contract that
 * tool functions return a string message to the model on failure).
 */
async function resolveLineItem(
  args: LineItemArg,
  ctx: Parameters<AiTool['run']>[1],
): Promise<ResolvedLineItem | string> {
  const shopProductId =
    typeof args.shop_product_id === 'string' ? args.shop_product_id.trim() : ''
  const variantId =
    typeof args.variant_id === 'string' ? args.variant_id.trim() : ''
  const variantTitle =
    typeof args.variant_title === 'string' ? args.variant_title.trim() : ''
  const qtyRaw = args.quantity
  const quantity =
    typeof qtyRaw === 'number' && qtyRaw > 0
      ? Math.min(Math.floor(qtyRaw), 100)
      : 1

  if (!shopProductId && !variantId) {
    return 'Missing both shop_product_id and variant_id — call product_lookup to get the values (shown as [product_id: X] and [variant_id: Y] in the output) and re-call.'
  }

  let product: {
    shop_product_id?: string
    variants?: unknown
    title?: string
    is_active?: boolean
  } | null = null

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

  if (!product && variantId) {
    const { data: allProducts, error: scanErr } = await ctx.db
      .from('products')
      .select('shop_product_id, variants, title, is_active')
      .eq('account_id', ctx.accountId)
      .eq('is_active', true)
    if (scanErr) {
      console.warn('[create_draft_order] active-catalogue scan failed:', scanErr)
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
    product = (found ?? null) as typeof product
  }

  if (!product) {
    return `Couldn't resolve product from shop_product_id="${shopProductId}" or variant_id="${variantId}". Call product_lookup again and copy the exact [product_id: X] and [variant_id: Y] values shown in the output — do NOT invent ids or use URL slugs.`
  }
  if (!(product as { is_active?: boolean }).is_active) {
    return `Product resolved but is currently inactive in the catalogue. Fall back to sharing the product URL and ask the customer to complete purchase on the website.`
  }
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
      const wanted = normalizeVariantTitle(variantTitle)
      const matches = variants.filter((v) => {
        if (!v.title) return false
        const t = normalizeVariantTitle(v.title)
        return t === wanted || t.includes(wanted) || wanted.includes(t)
      })
      if (matches.length === 1 && matches[0].id) {
        resolvedVariantId = matches[0].id
      } else if (matches.length > 1) {
        return `Variant title "${variantTitle}" matched multiple variants on ${resolvedShopProductId}. Ask the customer which specific size they want, then re-call with the exact variant_title or variant_id.`
      } else {
        return `Couldn't match variant "${variantTitle}" on product ${resolvedShopProductId}. Call product_lookup for this product to see the exact variant titles, decide which one the customer wants, and re-call create_draft_order with variant_id or variant_title.`
      }
    } else {
      return `Product ${resolvedShopProductId} has multiple variants. Call product_lookup for this product, decide the variant matching the customer's stated size/option, then re-call create_draft_order with variant_id or variant_title.`
    }
  } else {
    const match = variants.find((v) => v.id === resolvedVariantId)
    if (!match) {
      return `Variant ${resolvedVariantId} isn't on product ${resolvedShopProductId}. Call product_lookup to get current variant ids for this product and re-call with the correct one.`
    }
  }

  return { variant_id: resolvedVariantId, quantity }
}

export const createDraftOrderTool: AiTool = {
  name: 'create_draft_order',
  label: 'Create draft order',
  description:
    'Create a Shopify draft order for the customer and return ONE payment link. ' +
    'Call as SOON as the customer confirms they want to buy. ' +
    'For MULTIPLE items (cross-sell, catalog with 2+ products), pass line_items[] — ONE call = ONE draft = ONE payment link. Never call this tool twice for one purchase — that creates two separate orders and confuses the customer. ' +
    'For a single item you can either pass line_items:[{...}] or the flat shop_product_id/variant_id/quantity fields — both work. ' +
    'Address fields are OPTIONAL — if the customer already shared their name and full address, pass them so the checkout is pre-filled; if not, the customer will enter their address on the Shopify checkout page. ' +
    'The tool returns a checkout URL — share it verbatim and tell them to complete payment. ' +
    'Never claim the order is "placed" or "confirmed" — payment only completes when they pay at the URL.',
  parameters: {
    type: 'OBJECT',
    properties: {
      line_items: {
        type: 'ARRAY',
        description:
          'MULTIPLE items in one draft order — the preferred shape whenever the customer wants 2+ products. Each entry has the same {shop_product_id, variant_id, variant_title, quantity} keys as the flat single-item fields below. When line_items is given, the flat fields are IGNORED. Use this for catalog orders like "1× Honey + 1× Ghee".',
        items: {
          type: 'OBJECT',
          properties: {
            shop_product_id: { type: 'STRING' },
            variant_id: { type: 'STRING' },
            variant_title: { type: 'STRING' },
            quantity: { type: 'INTEGER' },
          },
        },
      },
      shop_product_id: {
        type: 'STRING',
        description:
          'Single-item shortcut. The product id shown as [product_id: X] in the product_lookup output. Preferred when you have it. Can be omitted if you pass variant_id — the tool will look up the parent product from the variant. IGNORED if line_items is provided.',
      },
      variant_id: {
        type: 'STRING',
        description:
          'Single-item shortcut. The specific variant id from product_lookup (numeric string). Required when the product has multiple variants unless you pass variant_title instead. IGNORED if line_items is provided.',
      },
      variant_title: {
        type: 'STRING',
        description:
          "Single-item shortcut. The variant's human-friendly title as the customer named it (e.g. '250ml', '500ml', '1000ml', '1L'). Use when you know which variant the customer picked but don't have the variant_id handy. Case-insensitive; '1L' matches '1000ml' etc. Ignored when variant_id is passed. IGNORED if line_items is provided.",
      },
      quantity: {
        type: 'INTEGER',
        description:
          'Single-item shortcut. How many units of this variant. Defaults to 1. IGNORED if line_items is provided.',
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

    const phone = ctx.contactPhone ?? undefined
    const customerName =
      typeof args.customer_name === 'string' ? args.customer_name.trim() : ''
    const addressLine1 =
      typeof args.address_line1 === 'string' ? args.address_line1.trim() : ''
    const addressLine2 =
      typeof args.address_line2 === 'string' ? args.address_line2.trim() : ''
    const city = typeof args.city === 'string' ? args.city.trim() : ''
    const state = typeof args.state === 'string' ? args.state.trim() : ''
    const pincode = typeof args.pincode === 'string' ? args.pincode.trim() : ''

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

    // line_items[] wins when provided. Otherwise treat the flat
    // fields as a one-item spec — keeps every existing single-item
    // AI call working unchanged.
    const rawItems = Array.isArray(args.line_items)
      ? (args.line_items as LineItemArg[])
      : [
          {
            shop_product_id: args.shop_product_id,
            variant_id: args.variant_id,
            variant_title: args.variant_title,
            quantity: args.quantity,
          } as LineItemArg,
        ]
    if (rawItems.length === 0) {
      return 'line_items[] was empty — pass at least one {variant_id or shop_product_id, quantity} entry.'
    }
    if (rawItems.length > 20) {
      return 'Too many items in one draft (max 20). Split into two calls if the customer really wants that many, or ask them to trim the order.'
    }

    // Resolve each item. First failure short-circuits and returns
    // the coaching message straight to the model — same contract as
    // the single-item path.
    const resolved: ResolvedLineItem[] = []
    for (const item of rawItems) {
      const r = await resolveLineItem(item, ctx)
      if (typeof r === 'string') return r
      resolved.push(r)
    }

    // Dedupe: if the model accidentally passed the same variant
    // twice, merge the quantities. Prevents a "1×A, 1×A" draft
    // that Shopify would happily accept but the customer would
    // find confusing.
    const merged = new Map<string, number>()
    for (const r of resolved) {
      merged.set(r.variant_id, (merged.get(r.variant_id) ?? 0) + r.quantity)
    }
    const lineItems = [...merged.entries()].map(([variant_id, quantity]) => ({
      variant_id,
      quantity,
    }))

    const baseUrl = (process.env.VANAMATI_APP_URL || '').replace(/\/$/, '')
    const apiKey = process.env.VANAMATI_ORDER_STATUS_KEY || ''

    try {
      // Payload shape: line_items[] is the new multi-item field.
      // For backwards compat with the Vanamati app's current
      // single-item endpoint, we ALSO include variant_id + quantity
      // at the top level when there's exactly one line item, so
      // an un-updated Vanamati app still works for the common case.
      // Once the app understands line_items[], the flat fields are
      // harmless duplicates.
      const payload: Record<string, unknown> = {
        line_items: lineItems,
        phone,
      }
      if (lineItems.length === 1) {
        payload.variant_id = lineItems[0].variant_id
        payload.quantity = lineItems[0].quantity
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

      const summary =
        lineItems.length > 1
          ? `Draft order created with ${lineItems.length} items — ONE payment link covers them all. Share verbatim (do NOT claim payment done; it happens on this page):`
          : `Draft order created. Share this payment link with the customer verbatim (do NOT claim the order is placed — payment happens on this page):`
      return `${summary}\n\n${body.invoice_url}`
    } catch (err) {
      console.warn('[create_draft_order] fetch failed:', err)
      return UNAVAILABLE
    }
  },
}
