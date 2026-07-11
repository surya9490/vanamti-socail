import type { AiTool } from './registry'
import {
  ASK_FOR_ORDER_NUMBER,
  LOOKUP_UNAVAILABLE,
  extractOrderNumber,
  fetchOrderStatusReply,
  orderTrackingConfigured,
} from '@/lib/orders/order-tracking'

// ============================================================
// order_lookup tool — the conversational twin of the flow / automation
// order-lookup step. Lets the AI answer "where's my order #1024?" inline
// instead of routing to a rigid flow. Reuses the same Vanamati client and
// the same safety property: the lookup always uses the CONTACT'S stored
// phone (never a value from the model), and the app refuses mismatched
// phones, so a customer can only ever see their own orders.
// ============================================================

export const orderLookupTool: AiTool = {
  name: 'order_lookup',
  label: 'Order lookup',
  description:
    "Look up the status of the customer's own order (e.g. shipping / delivery status). " +
    "Call this when the customer asks about an order, tracking, or 'where is my order'. " +
    'Pass the order number if the customer mentioned one.',
  parameters: {
    type: 'OBJECT',
    properties: {
      order_number: {
        type: 'STRING',
        description:
          "The customer's order number if they gave one (e.g. '1024' or '#SO-1024'). Omit if they didn't.",
      },
    },
    required: [],
  },
  async run(args, ctx) {
    // Not wired up on this deployment (no Vanamati app URL/key) — degrade
    // gracefully rather than pretend.
    if (!orderTrackingConfigured()) return LOOKUP_UNAVAILABLE
    // No phone on file → we can't verify ownership, so we can't look up.
    if (!ctx.contactPhone) return LOOKUP_UNAVAILABLE

    const raw = typeof args.order_number === 'string' ? args.order_number : ''
    const orderNumber = extractOrderNumber(raw)
    if (!orderNumber) return ASK_FOR_ORDER_NUMBER

    const reply = await fetchOrderStatusReply({
      orderNumber,
      senderPhone: ctx.contactPhone,
    })
    return reply ?? LOOKUP_UNAVAILABLE
  },
}
