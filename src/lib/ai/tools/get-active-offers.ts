import type { AiTool } from './registry'

// ============================================================
// get_active_offers tool — the ONLY source of truth for discount
// codes and percentages the AI may quote.
//
// Why a tool and not the knowledge base: the KB is scraped from the
// website, and every page carries the signup-popup chrome ("Get 5%
// off your first order"). That copy goes stale the moment the
// operator changes the offer in the Vanamati app — the bot was
// telling customers "10% isn't available, only 5%" while the live
// welcome offer was 10%. Discounts live in Shopify, minted by the
// Vanamati app; only the app knows the current truth.
//
// Two offer kinds come back:
//   * welcome       — one shared first-order code (merchant-set
//                     percent + minimum). Static-ish; changes when
//                     the operator edits app settings.
//   * cart_recovery — a per-cart, single-use, short-lived code the
//                     app minted for THIS customer's abandoned cart.
//                     Looked up by the customer's WhatsApp phone.
//
// Safety: phone always comes from ctx.contactPhone (Meta-verified),
// never from the model. Same pattern as order_lookup.
//
// Config: VANAMATI_APP_URL + VANAMATI_ORDER_STATUS_KEY (shared
// WACRM→Vanamati internal key). Missing → UNAVAILABLE, and the
// prompt tells the model not to quote any number in that case.
// ============================================================

const UNAVAILABLE =
  'Offer lookup is unavailable right now. Do NOT quote any discount percentage or code — say you\'ll confirm the current offer and move on.'

function offersConfigured(): boolean {
  return Boolean(
    process.env.VANAMATI_APP_URL && process.env.VANAMATI_ORDER_STATUS_KEY,
  )
}

interface OffersResponse {
  ok?: boolean
  welcome?: {
    code: string
    percent: number
    min_purchase_rupees: number | null
  } | null
  cart_recovery?: {
    code: string
    percent: number
    expires_at: string
    cart_total_rupees: number | null
  } | null
}

function formatExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return 'expiring now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `expires in ${mins} min`
  const hrs = Math.round(mins / 60)
  return `expires in ${hrs} hour${hrs === 1 ? '' : 's'}`
}

export const getActiveOffersTool: AiTool = {
  name: 'get_active_offers',
  label: 'Live discount offers',
  description:
    'Fetch the CURRENT discount codes for this customer from the store. ' +
    'Call this BEFORE quoting any discount, coupon, offer, or percentage — including when the customer asks "any discount?", "any offer?", "coupon code?", or when you want to sweeten a hesitant buyer or a COD objection. ' +
    'Returns the shared first-order welcome code (if any) and a per-customer abandoned-cart code (if one is live). ' +
    'NEVER quote a discount from memory or from the knowledge base — website copy about "% off" is stale. Only quote what this tool returns.',
  parameters: {
    type: 'OBJECT',
    properties: {},
    required: [],
  },
  async run(_args, ctx) {
    if (!offersConfigured()) return UNAVAILABLE

    const baseUrl = (process.env.VANAMATI_APP_URL || '').replace(/\/$/, '')
    const apiKey = process.env.VANAMATI_ORDER_STATUS_KEY || ''
    const qs = ctx.contactPhone
      ? `?phone=${encodeURIComponent(ctx.contactPhone)}`
      : ''

    try {
      const res = await fetch(`${baseUrl}/api/offers${qs}`, {
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(6000),
      })
      if (!res.ok) {
        console.warn(
          `[get_active_offers] Vanamati ${res.status}:`,
          (await res.text().catch(() => '')).slice(0, 200),
        )
        return UNAVAILABLE
      }
      const body = (await res.json()) as OffersResponse

      const lines: string[] = []
      if (body.welcome?.code) {
        const w = body.welcome
        const min =
          w.min_purchase_rupees && w.min_purchase_rupees > 0
            ? ` on orders of ₹${w.min_purchase_rupees}+`
            : ''
        lines.push(
          `FIRST-ORDER code: ${w.code} — ${w.percent}% off${min}. One use per customer; only for a customer's FIRST order.`,
        )
      }
      if (body.cart_recovery?.code) {
        const c = body.cart_recovery
        const total =
          c.cart_total_rupees && c.cart_total_rupees > 0
            ? ` (their abandoned cart was ₹${c.cart_total_rupees})`
            : ''
        lines.push(
          `THIS CUSTOMER's cart-recovery code: ${c.code} — ${c.percent}% off, single use, ${formatExpiry(c.expires_at)}${total}. Use this one if they're coming back to finish a cart.`,
        )
      }
      if (lines.length === 0) {
        return 'No discount codes are live right now. Do not offer any code or percentage — lean on free shipping above ₹499 and product value instead.'
      }
      return (
        'LIVE OFFERS (quote ONLY these — ignore any "% off" text in the knowledge base):\n' +
        lines.map((l) => `• ${l}`).join('\n')
      )
    } catch (err) {
      console.warn('[get_active_offers] fetch failed:', err)
      return UNAVAILABLE
    }
  },
}
