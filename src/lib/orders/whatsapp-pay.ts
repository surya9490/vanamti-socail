import { engineSendRawMessage } from '@/lib/flows/meta-send'

// ============================================================
// Native WhatsApp Payments for catalog carts — the CRM's half.
//
// A relay: the Vanamati app prices everything from Shopify and builds
// every message (address form, "Review and pay" order card, "Checkout
// on website" button, order-status update). This file passes WhatsApp
// events to it and sends back whatever it returns.
//
//   catalog cart (order msg)  → POST /api/whatsapp-pay/cart     → address form
//   address form reply        → POST /api/whatsapp-pay/checkout → order card + checkout button
//   payment status webhook    → POST /api/whatsapp-pay/status   → "confirmed" card update
//
// Switched on/off in the app (Payments → "WhatsApp Pay for catalog
// carts"). When it's off, unreachable, or errors, these return false
// and the webhook carries on exactly as before (the AI handles the cart).
//
// Config: VANAMATI_APP_URL + VANAMATI_ORDER_STATUS_KEY (the shared
// WACRM → Vanamati key), WHATSAPP_CATALOG_RETAILER_ID_PREFIX (optional).
// ============================================================

/** A Graph API message body without `messaging_product` / `to`. */
type GraphMessage = { type: string } & Record<string, unknown>

interface Target {
  accountId: string
  conversationId: string
  contactId: string
}

function configured(): boolean {
  return Boolean(process.env.VANAMATI_APP_URL && process.env.VANAMATI_ORDER_STATUS_KEY)
}

async function callApp<T>(path: string, body: unknown): Promise<T | null> {
  if (!configured()) return null
  try {
    const res = await fetch(`${process.env.VANAMATI_APP_URL!.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.VANAMATI_ORDER_STATUS_KEY!,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      console.warn(`[whatsapp-pay] ${path} answered ${res.status}`)
      return null
    }
    return (await res.json()) as T
  } catch (err) {
    console.warn(`[whatsapp-pay] ${path} failed:`, err instanceof Error ? err.message : err)
    return null
  }
}

/** What the inbox shows for a message it can't render itself. */
export function summarizeGraphMessage(message: GraphMessage): string {
  if (message.type === 'text') {
    return String((message.text as { body?: string } | undefined)?.body ?? '')
  }
  const interactive = (message.interactive ?? {}) as {
    type?: string
    body?: { text?: string }
    action?: { parameters?: { url?: string } }
  }
  const body = interactive.body?.text ?? ''
  switch (interactive.type) {
    case 'address_message':
      return `[Address form] ${body}`
    case 'order_details':
      return `[WhatsApp Pay order card] ${body}`
    case 'order_status':
      return `[Order update] ${body}`
    case 'cta_url':
      return `${body} ${interactive.action?.parameters?.url ?? ''}`.trim()
    default:
      return body || '[Interactive message]'
  }
}

async function sendAll(target: Target, messages: GraphMessage[] | undefined): Promise<boolean> {
  if (!messages?.length) return false
  for (const message of messages) {
    await engineSendRawMessage({ ...target, message, summaryText: summarizeGraphMessage(message) })
  }
  return true
}

/**
 * A cart from the WhatsApp catalog. True when WhatsApp Pay took it (the
 * address form went out), so the AI must not also answer it.
 */
export async function handleCatalogCart(
  args: Target & {
    phone: string
    name: string | null
    order: {
      catalog_id?: string
      product_items: Array<{ product_retailer_id: string; quantity: number }>
    }
  },
): Promise<boolean> {
  if (!args.phone) return false
  const result = await callApp<{ enabled?: boolean; messages?: GraphMessage[] }>('/api/whatsapp-pay/cart', {
    phone: args.phone,
    name: args.name,
    catalog_id: args.order.catalog_id ?? process.env.WHATSAPP_CATALOG_ID ?? null,
    retailer_prefix: process.env.WHATSAPP_CATALOG_RETAILER_ID_PREFIX ?? '',
    product_items: args.order.product_items,
  })
  if (!result?.enabled) return false
  try {
    return await sendAll(args, result.messages)
  } catch (err) {
    console.error('[whatsapp-pay] sending the address form failed:', err)
    return false
  }
}

/**
 * The customer sent WhatsApp's address form back. True when it belonged
 * to a WhatsApp Pay cart and the order card (or a reason it couldn't be
 * priced) went out.
 */
export async function handleAddressReply(
  args: Target & { phone: string; responseJson: string },
): Promise<boolean> {
  if (!args.phone) return false
  const result = await callApp<{ ok?: boolean; messages?: GraphMessage[] }>('/api/whatsapp-pay/checkout', {
    phone: args.phone,
    response_json: args.responseJson,
  })
  if (!result?.ok) return false
  try {
    return await sendAll(args, result.messages)
  } catch (err) {
    console.error('[whatsapp-pay] sending the order card failed:', err)
    return false
  }
}

/**
 * One of WhatsApp's payment status webhooks. The app checks it with
 * Razorpay and completes the order; we send the card update it returns.
 * Never throws — the app's reconcile job covers anything lost here.
 */
export async function handlePaymentStatus(args: Target & { status: unknown }): Promise<void> {
  const result = await callApp<{ messages?: GraphMessage[] }>('/api/whatsapp-pay/status', { status: args.status })
  try {
    await sendAll(args, result?.messages)
  } catch (err) {
    console.error('[whatsapp-pay] sending the order update failed:', err)
  }
}
