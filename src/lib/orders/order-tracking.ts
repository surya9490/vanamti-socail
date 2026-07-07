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
export function extractOrderNumber(text: string | null | undefined): string | null {
  if (!text) return null
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
