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
          'The product id from product_lookup (numeric string, e.g. "8123456789"). Required.',
      },
      variant_id: {
        type: 'STRING',
        description:
          'The specific variant id from product_lookup (numeric string). Required when the product has multiple variants; omit for single-variant products.',
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
    required: ['shop_product_id'],
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

    if (!shopProductId) {
      return 'Missing shop_product_id — call product_lookup first to get the correct id.'
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

    // Verify the product (and variant if specified) actually exists
    // in our cache before we ask Shopify. A stale model call for a
    // non-existent product should fail fast with a clear message
    // rather than surface as an opaque Shopify error.
    const { data: product, error: productErr } = await ctx.db
      .from('products')
      .select('variants, title, is_active')
      .eq('account_id', ctx.accountId)
      .eq('shop_product_id', shopProductId)
      .maybeSingle()
    if (productErr) {
      console.warn('[create_draft_order] product lookup failed:', productErr)
      return UNAVAILABLE
    }
    if (!product || !(product as { is_active?: boolean }).is_active) {
      return `Product ${shopProductId} isn't available right now.`
    }
    const variants = Array.isArray((product as { variants?: unknown }).variants)
      ? ((product as { variants: unknown[] }).variants as Array<{
          id?: string
          title?: string | null
        }>)
      : []

    let resolvedVariantId = variantId
    if (!resolvedVariantId) {
      if (variants.length === 0) {
        return `Product ${shopProductId} has no variant on file — try refreshing the catalogue backfill.`
      }
      if (variants.length > 1) {
        return `Product "${(product as { title?: string }).title ?? shopProductId}" has multiple variants — call product_lookup to see them and pass the specific variant_id.`
      }
      const only = variants[0]
      if (!only?.id) return UNAVAILABLE
      resolvedVariantId = only.id
    } else {
      // Verify the model-supplied variant belongs to this product.
      const match = variants.find((v) => v.id === resolvedVariantId)
      if (!match) {
        return `Variant ${resolvedVariantId} isn't on product ${shopProductId}.`
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
