import { callApp, sendAll, type GraphMessage, type Target } from './whatsapp-pay'

// ============================================================
// The WhatsApp Flow shop — the CRM's half.
//
// Like WhatsApp Pay, a relay: the Vanamati app owns the Flow (its
// screens, the encrypted endpoint WhatsApp calls from inside it, the
// cart, the prices) and builds every message. This file asks it for
// the "Shop now" message and passes the Flow's closing reply back.
//
//   customer wants to see products → POST /api/whatsapp-shop/open
//       → the "Shop now" message that opens the Flow
//   the Flow closed ("Place order") → POST /api/whatsapp-shop/complete
//       → a "Pay now" button for the order (or the UPI pay options)
//
// Switched on/off in the app (Payments → "WhatsApp shop"). When it's
// off, unreachable, or errors, these return false and the caller
// carries on as before (the catalog message; the AI).
// ============================================================

/**
 * Send the shop instead of the catalog message. True when it went out.
 */
export async function openShop(args: Target & { phone: string; name: string | null }): Promise<boolean> {
  if (!args.phone) return false
  const result = await callApp<{ enabled?: boolean; messages?: GraphMessage[] }>('/api/whatsapp-shop/open', {
    phone: args.phone,
    name: args.name,
  })
  if (!result?.enabled) return false
  try {
    return await sendAll(args, result.messages)
  } catch (err) {
    console.error('[whatsapp-shop] sending the shop failed:', err)
    return false
  }
}

/**
 * A Flow closed and WhatsApp sent its reply. True when it was the shop's
 * (the app knows its own flow tokens) — the pay button went out, and the
 * AI must not answer too. False for any other Flow.
 */
export async function handleShopReply(args: Target & { phone: string; responseJson: string }): Promise<boolean> {
  if (!args.phone) return false
  const result = await callApp<{ ok?: boolean; messages?: GraphMessage[] }>('/api/whatsapp-shop/complete', {
    phone: args.phone,
    response_json: args.responseJson,
  })
  if (!result?.ok) return false
  try {
    // A repeat delivery is ours too, with nothing more to send.
    await sendAll(args, result.messages)
    return true
  } catch (err) {
    console.error('[whatsapp-shop] sending the pay button failed:', err)
    return true
  }
}
