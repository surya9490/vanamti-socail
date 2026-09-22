import type { AiTool } from './registry'
import { CLARIFY_MESSAGE, FUTURE_ORDER_MESSAGE, ORDER_HOLDING_MESSAGE } from '@/lib/ai/order-guard'
import {
  LOOKUP_UNAVAILABLE,
  extractOrderNumber,
  fetchOrderStatus,
  fetchRecentOrders,
  orderTrackingConfigured,
} from '@/lib/orders/order-tracking'

/** The store's tracking page — customers can check any shipped order there. */
export const TRACK_PAGE_URL = 'https://vanamati.com/apps/track123'

// Tool results are read by the model, not sent verbatim. A miss is the
// dangerous case: "no order found" read as "you have no order" made a
// customer who HAD a 5-day-old order panic (live, 2026-09-22). So a miss
// never comes back as bare copy — it comes back as instructions.

const CARE_NOTE =
  `\n\n[Customer-care mode: relay this status warmly in your own words. Quote the order number EXACTLY as written above (e.g. #vana1073), not as the customer typed it. For tracking, the store's page is ${TRACK_PAGE_URL}. Do NOT invent how they'll be notified — no "SMS", no "call": tracking details come by email and on the tracking page. Do not pitch products or suggest a new order.]`

const DELAYED_NOTE =
  '\n\n[DELAYED ORDER — this order is past its promised dispatch time. Apologise sincerely in ONE short line, say our team is checking it now and will update them here shortly (do NOT promise a date), then end your reply with [[HANDOFF]] so a person expedites it. No products, no upsell.]'

export function notFoundGuidance(
  orderNumber: string | null,
  intent?: 'existing_order' | 'future_order' | 'ambiguous' | 'sales' | 'none',
): string {
  if (intent === 'future_order') {
    return (
      '[NO ORDER MATCHED, AND NONE WAS EXPECTED — instructions for you.] The customer said they will order LATER; this lookup should not have run. ' +
      `Do NOT send a holding line, do NOT hand off, do NOT ask for address or payment. Reply warmly in one or two lines like: "${FUTURE_ORDER_MESSAGE}" — confirm any items they mentioned, then stop.`
    )
  }
  if (intent === 'ambiguous' || intent === 'sales' || intent === 'none') {
    return (
      '[NO ORDER MATCHED — instructions for you.] The customer has not clearly asked about an existing order, so do not guess. ' +
      `Do NOT say they have no order, do NOT hand off. Reply with exactly: "${CLARIFY_MESSAGE}"`
    )
  }
  const what = orderNumber
    ? `No order named "${orderNumber}" matched THIS customer's WhatsApp number.`
    : "No order matched THIS customer's WhatsApp number."
  return (
    `[ORDER NOT MATCHED — instructions for you, not text to send.] ${what} ` +
    'This does NOT mean they have no order: they may have ordered with another phone number or email, or typed the number slightly differently. ' +
    'NEVER say or imply "you have no order", "no order was placed", "it wasn\'t completed", and NEVER offer to place a new order, send the catalog or mention products — that panics a customer who has paid. ' +
    (orderNumber
      ? `They already gave an order number, so do not make them hunt again: reply with exactly "${ORDER_HOLDING_MESSAGE}" and end your reply with [[HANDOFF]].`
      : `Reply with exactly "${ORDER_HOLDING_MESSAGE}" and end your reply with [[HANDOFF]] — a person will find the order (the customer may have used another phone number / email at checkout).`)
  )
}

export const LOOKUP_DOWN_GUIDANCE =
  `[ORDER SYSTEM DID NOT RESPOND — instructions for you.] Do NOT say they have no order. Reply with exactly "${ORDER_HOLDING_MESSAGE}" and end your reply with [[HANDOFF]].`

// ============================================================
// order_lookup tool — the conversational twin of the flow /
// automation order-lookup step. Lets the AI answer "where's my
// order" inline.
//
// Two invocation shapes:
//   * With order_number → look up that specific order (uses
//     Vanamati's /api/order-status, which does live Shiprocket
//     enrichment and returns a full status).
//   * WITHOUT order_number → list this customer's recent orders
//     by phone (uses Vanamati's /api/orders/by-phone). Lets the
//     AI answer "where's my order" without making the customer
//     hunt for an order number.
//
// Safety property (both paths): the lookup ALWAYS uses ctx.contactPhone
// (the customer's Meta-verified WhatsApp number), never a value from
// the model. The Vanamati app matches every phone slot on the order
// against this — mismatches respond identically to no-orders, so
// order numbers / phone numbers can't be probed.
// ============================================================

export const orderLookupTool: AiTool = {
  name: 'order_lookup',
  label: 'Order lookup',
  description:
    "Look up the customer's own order status. Call this when the customer asks about tracking, shipping, or 'where is my order'. " +
    "If the customer gave a specific order number, pass it — you'll get the live status for that order. " +
    "If the customer just asked generally ('where is my order?', 'track my order') WITHOUT a specific number, call WITHOUT order_number — the tool will list their recent orders based on their WhatsApp phone. Prefer this over asking the customer to hunt for their order number.",
  parameters: {
    type: 'OBJECT',
    properties: {
      order_number: {
        type: 'STRING',
        description:
          "The customer's order number if they gave one (e.g. '1024', '#vana1024', '#SO-1024'). Omit ENTIRELY if they didn't — the tool will auto-list their recent orders by phone.",
      },
    },
    required: [],
  },
  async run(args, ctx) {
    // Not wired up on this deployment (no Vanamati app URL/key) —
    // degrade gracefully rather than pretend.
    if (!orderTrackingConfigured()) return LOOKUP_UNAVAILABLE
    // No phone on file → we can't verify ownership on either path.
    if (!ctx.contactPhone) return LOOKUP_UNAVAILABLE

    const raw = typeof args.order_number === 'string' ? args.order_number : ''
    const orderNumber = extractOrderNumber(raw)

    const result = orderNumber
      ? await fetchOrderStatus({ orderNumber, senderPhone: ctx.contactPhone })
      : // No order number → list recent orders by phone. Zero-friction
        // path: the customer's WhatsApp phone is our identity.
        await fetchRecentOrders({ senderPhone: ctx.contactPhone })

    // The order guard (lib/ai/order-guard.ts) reads this after the model
    // replies: a miss or an outage ALWAYS becomes the holding line + a
    // handoff, whatever the model wrote.
    ctx.signals = ctx.signals ?? {}
    if (!result) {
      ctx.signals.orderLookup = 'down'
      return LOOKUP_DOWN_GUIDANCE
    }
    if (!result.found) {
      ctx.signals.orderLookup = 'missed'
      return notFoundGuidance(orderNumber, ctx.signals.customerIntent)
    }
    ctx.signals.orderLookup = result.delayed ? 'delayed' : 'found'
    return result.message + (result.delayed ? DELAYED_NOTE : CARE_NOTE)
  },
}
