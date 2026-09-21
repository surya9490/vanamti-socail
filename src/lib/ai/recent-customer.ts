// ============================================================
// "Recent customer" detection — shared by the AI reply prompt, the
// close-nudge cron and the re-engagement cron.
//
// Someone who ordered in the last few days and comes back is here
// for SUPPORT (order status, delivery, a question), not to be sold
// to again. Opening with the catalog, listing products, or sending a
// "still thinking it over?" follow-up to them reads as spam — seen
// live 2026-09-21: an order-confirmation template on the 19th, the
// customer asked "status of this order" on the 21st, the bot led
// with the catalog and the 3h check-in fired that afternoon.
//
// Signals, any of which marks the thread as a recent customer:
//   * a transactional template on the thread within the window —
//     order confirmation / management, shipping or delivery status,
//     review request (NOT cart recovery or the welcome code: those
//     go to people who have NOT bought)
//   * an order number mentioned by either side within the window
//     ("#vana1061") — covers the case where the confirmation
//     template failed to send (e.g. still pending Meta review)
//
// The window is 10 days by default (RECENT_CUSTOMER_DAYS).
// ============================================================

export const RECENT_CUSTOMER_DAYS_DEFAULT = 10

export interface RecentCustomerMessage {
  created_at: string
  content_type: string | null
  template_name: string | null
  content_text: string | null
}

/** Templates that only ever go to someone who has placed an order. */
const TRANSACTIONAL_TEMPLATE_RE =
  /(order|deliver|ship|fulfil|review|dispatch|track)/i
/** …minus the ones that go to people who have NOT bought. */
const NOT_A_PURCHASE_TEMPLATE_RE = /(cart|abandon|welcome|recover)/i

/** Order numbers as Shopify names them for this store ("#vana1061"). */
const ORDER_NUMBER_RE = /#?\bvana\d{3,}\b/i

export function isTransactionalTemplate(name: string | null | undefined): boolean {
  if (!name) return false
  return TRANSACTIONAL_TEMPLATE_RE.test(name) && !NOT_A_PURCHASE_TEMPLATE_RE.test(name)
}

export interface RecentCustomerVerdict {
  recent: boolean
  /** What tripped it, for logs. */
  signal: 'transactional_template' | 'order_number' | null
  /** ISO time of the signal message. */
  at: string | null
}

export function detectRecentCustomer(
  messages: readonly RecentCustomerMessage[],
  opts: { now: number; windowDays?: number },
): RecentCustomerVerdict {
  const windowMs = (opts.windowDays ?? RECENT_CUSTOMER_DAYS_DEFAULT) * 24 * 3_600_000
  const cutoff = opts.now - windowMs
  let best: RecentCustomerVerdict = { recent: false, signal: null, at: null }
  for (const m of messages) {
    const t = new Date(m.created_at).getTime()
    if (!Number.isFinite(t) || t < cutoff || t > opts.now + 60_000) continue
    if (m.content_type === 'template' && isTransactionalTemplate(m.template_name)) {
      if (!best.at || t > new Date(best.at).getTime()) {
        best = { recent: true, signal: 'transactional_template', at: m.created_at }
      }
      continue
    }
    if (m.content_text && ORDER_NUMBER_RE.test(m.content_text)) {
      if (!best.at || t > new Date(best.at).getTime()) {
        best = { recent: true, signal: 'order_number', at: m.created_at }
      }
    }
  }
  return best
}

export function recentCustomerWindowDays(): number {
  const raw = Number(process.env.RECENT_CUSTOMER_DAYS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : RECENT_CUSTOMER_DAYS_DEFAULT
}
