// ============================================================
// Order-tracking lookup — powers the `order_lookup` AUTOMATION step.
//
// Merchants compose it in the Automations UI, e.g.:
//   Trigger: Keyword Match ["track", "order status", "where is my order"]
//   Step:    Order Status Lookup (Vanamati)
//
// The step extracts the order number from the triggering message,
// calls the Vanamati Shopify app's order-status endpoint with the
// CONTACT'S phone (the app refuses mismatched phones, so customers
// can only track their own orders), and replies with the ready-made
// message the app returns.
//
// Config (both required to activate; unset = step fails with a clear
// log message):
//   VANAMATI_APP_URL           e.g. https://app.vanamati.com
//   VANAMATI_ORDER_STATUS_KEY  dedicated token — matches the app's
//                              ORDER_STATUS_API_KEY (deliberately NOT
//                              the app's admin master key: this token
//                              can do exactly one thing)
// ============================================================

const VANAMATI_APP_URL = (process.env.VANAMATI_APP_URL || '').replace(/\/$/, '')
const VANAMATI_ORDER_STATUS_KEY = process.env.VANAMATI_ORDER_STATUS_KEY || ''

export function orderTrackingConfigured(): boolean {
  return Boolean(VANAMATI_APP_URL && VANAMATI_ORDER_STATUS_KEY)
}

/**
 * Pull an order number out of a message that already passed the
 * merchant's keyword trigger. Permissive on purpose (the trigger did
 * the intent filtering): first #-prefixed token wins, else the first
 * standalone 3-12 digit number.
 *
 * The #-prefixed form accepts alphanumerics + hyphens so that Shopify
 * merchants using named orders like `#ABC-1024` or `#SO-1024` are
 * covered — Shopify's default order name IS `#1001` etc, but the
 * order-name field is fully customisable, and many stores prefix or
 * pad. The bare form is digit-only to avoid grabbing random words
 * ("track my package" wouldn't produce a spurious hit).
 *
 * The upper bound (12 digits / 24-char token) is generous enough for
 * any reasonable order-name length while staying too short to grab
 * phone numbers by accident (E.164 numbers are longer and typically
 * carry non-digit prefixes like `+`).
 */
/**
 * The store's order-name prefix ("vana" → orders are named #vana1073).
 * Customers usually type it WITHOUT the '#' ("vana1073", "VANA 1073"), which
 * the #-form and the bare-digit form both miss — seen live 2026-09-22, when
 * "vana1073" made the bot say the order didn't exist.
 */
const ORDER_NAME_PREFIX = (process.env.ORDER_NAME_PREFIX || 'vana').trim()

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function extractOrderNumber(text: string | null | undefined): string | null {
  if (!text) return null
  if (ORDER_NAME_PREFIX) {
    const prefixed = text.match(
      new RegExp(`(?:^|[^A-Za-z0-9])#?\\s*(${escapeRegExp(ORDER_NAME_PREFIX)})\\s*[-#]?\\s*(\\d{3,12})\\b`, 'i'),
    )
    if (prefixed) return `${prefixed[1]}${prefixed[2]}`
  }
  const hash = text.match(/#\s*([A-Za-z0-9][A-Za-z0-9-]{2,23})\b/)
  if (hash) return hash[1]
  const bare = text.match(/\b(\d{3,12})\b/)
  return bare ? bare[1] : null
}

export const ASK_FOR_ORDER_NUMBER =
  'Happy to check! Please send your order number (it’s in your confirmation email), e.g. "track 1024".'

export const LOOKUP_UNAVAILABLE =
  'We couldn’t check that right now — please try again in a few minutes.'

interface OrderStatusResponse {
  found: boolean
  message: string
  /** Confirmed but unshipped past the promised dispatch window. */
  delayed?: boolean
}

/** What a lookup returned — the AI tool needs `found` / `delayed`, not just text. */
export interface OrderLookupResult {
  found: boolean
  message: string
  delayed: boolean
}

/** Single-order lookup with its outcome. Null when the lookup could not run. */
export async function fetchOrderStatus(params: {
  orderNumber: string
  senderPhone: string
}): Promise<OrderLookupResult | null> {
  if (!orderTrackingConfigured()) return null
  try {
    const url =
      `${VANAMATI_APP_URL}/api/order-status` +
      `?order=${encodeURIComponent(params.orderNumber)}` +
      `&phone=${encodeURIComponent(params.senderPhone)}`
    const resp = await fetch(url, {
      headers: { 'x-api-key': VANAMATI_ORDER_STATUS_KEY },
    })
    // A 5xx is "couldn't check", never "not found".
    if (resp.status >= 500) return null
    const json = (await resp.json().catch(() => null)) as OrderStatusResponse | null
    if (!json || typeof json.message !== 'string' || !json.message) return null
    return { found: json.found === true, message: json.message, delayed: json.delayed === true }
  } catch (error) {
    console.error(
      '[order-tracking] lookup failed:',
      error instanceof Error ? error.message : error,
    )
    return null
  }
}

/** Recent-orders-by-phone lookup with its outcome. Null when it could not run. */
export async function fetchRecentOrders(params: {
  senderPhone: string
  limit?: number
}): Promise<OrderLookupResult | null> {
  if (!orderTrackingConfigured()) return null
  try {
    const qs = new URLSearchParams({ phone: params.senderPhone })
    if (params.limit) qs.set('limit', String(params.limit))
    const url = `${VANAMATI_APP_URL}/api/orders/by-phone?${qs.toString()}`
    const resp = await fetch(url, {
      headers: { 'x-api-key': VANAMATI_ORDER_STATUS_KEY },
    })
    if (resp.status >= 500) return null
    const json = (await resp.json().catch(() => null)) as {
      found?: boolean
      message?: string
      orders?: Array<{ delayed?: boolean }>
    } | null
    if (!json || typeof json.message !== 'string' || !json.message) return null
    return {
      found: json.found === true,
      message: json.message,
      delayed: (json.orders ?? []).some((o) => o?.delayed === true),
    }
  } catch (error) {
    console.error(
      '[order-tracking] by-phone lookup failed:',
      error instanceof Error ? error.message : error,
    )
    return null
  }
}

/**
 * Ask the Vanamati app for the order status. Returns the ready-to-send
 * reply text, or null when the lookup could not run (network failure /
 * malformed response). Callers decide the fallback copy.
 */
export async function fetchOrderStatusReply(params: {
  orderNumber: string
  senderPhone: string
}): Promise<string | null> {
  if (!orderTrackingConfigured()) return null
  try {
    const url =
      `${VANAMATI_APP_URL}/api/order-status` +
      `?order=${encodeURIComponent(params.orderNumber)}` +
      `&phone=${encodeURIComponent(params.senderPhone)}`
    const resp = await fetch(url, {
      headers: { 'x-api-key': VANAMATI_ORDER_STATUS_KEY },
    })
    const json = (await resp.json().catch(() => null)) as OrderStatusResponse | null
    if (!json || typeof json.message !== 'string' || !json.message) return null
    return json.message
  } catch (error) {
    console.error(
      '[order-tracking] lookup failed:',
      error instanceof Error ? error.message : error,
    )
    return null
  }
}

/**
 * Ask the Vanamati app for this customer's recent orders based on
 * their WhatsApp phone. Used when the customer expressed order
 * intent but didn't provide an order number — no need to make them
 * hunt for it in their confirmation email.
 *
 * Returns the ready-to-send reply (a short list of recent orders
 * with statuses + tracking links), or null on lookup failure.
 * Callers decide the fallback copy.
 */
export async function fetchRecentOrdersReply(params: {
  senderPhone: string
  limit?: number
}): Promise<string | null> {
  if (!orderTrackingConfigured()) return null
  try {
    const qs = new URLSearchParams({ phone: params.senderPhone })
    if (params.limit) qs.set('limit', String(params.limit))
    const url = `${VANAMATI_APP_URL}/api/orders/by-phone?${qs.toString()}`
    const resp = await fetch(url, {
      headers: { 'x-api-key': VANAMATI_ORDER_STATUS_KEY },
    })
    const json = (await resp.json().catch(() => null)) as {
      message?: string
    } | null
    if (!json || typeof json.message !== 'string' || !json.message) return null
    return json.message
  } catch (error) {
    console.error(
      '[order-tracking] by-phone lookup failed:',
      error instanceof Error ? error.message : error,
    )
    return null
  }
}
