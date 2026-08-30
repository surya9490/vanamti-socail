import type { AiTool } from './registry'
import {
  LOOKUP_UNAVAILABLE,
  extractOrderNumber,
  fetchOrderStatusReply,
  fetchRecentOrdersReply,
  orderTrackingConfigured,
} from '@/lib/orders/order-tracking'

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

    if (orderNumber) {
      const reply = await fetchOrderStatusReply({
        orderNumber,
        senderPhone: ctx.contactPhone,
      })
      return reply ?? LOOKUP_UNAVAILABLE
    }

    // No order number → list recent orders by phone. Zero-friction
    // path: the customer's WhatsApp phone is our identity, we
    // don't need to ask them for anything else.
    const listReply = await fetchRecentOrdersReply({
      senderPhone: ctx.contactPhone,
    })
    return listReply ?? LOOKUP_UNAVAILABLE
  },
}
