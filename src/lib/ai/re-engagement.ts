// ============================================================
// Re-engagement eligibility — pure helpers for the hourly cron
// (app/api/cron/re-engagement).
//
// Who gets a re-engagement message: any contact whose thread went
// quiet on THEIR side after OUR last message. Lead grade is
// deliberately not a filter. Grades ratchet upward and 'cold' is
// rare (1 of 164 contacts on the live account on 2026-09-20), so
// keying on it meant the cron never fired for the people it was
// built for — warm leads who asked, got an answer, and drifted.
//
// Safety rails, per thread:
//   * conversation is open (closed / pending = someone decided)
//   * AI not paused on it (a human is handling — don't talk over them)
//   * the customer has written at least once (a broadcast-only
//     contact isn't "silent", they never spoke)
//   * the last message is OURS — if the customer's message is the
//     latest, they're waiting on us, not the other way round
//   * the last message isn't a transactional template (order
//     confirmation, review request, cart recovery, …) — that
//     customer is in a post-purchase / app-driven flow. Our own
//     re-engagement templates are exempt so stage 2 can follow
//     stage 1.
//   * silence < max age (the cron's 7-day default)
//   * the thread is in a SALES stage — in the current session we
//     showed products (catalog) or moved toward checkout (address /
//     payment). A support-only thread ("where is my order?" →
//     "you're welcome") is never re-engaged.
//   * a RECENT CUSTOMER (ordered within the last ~10 days, see
//     recent-customer.ts) is re-engaged only when they were explicitly
//     mid-checkout (address / payment stage). A catalog alone doesn't
//     count for them — they didn't come to shop.
//
// Plus a quiet-hours window (default 22:00–08:00 Asia/Kolkata): a
// nudge at 1 am reads as spam and earns blocks.
// ============================================================

import { detectCloseStage, type CloseStage } from './close-nudge'

export type SalesStage = CloseStage | 'catalog'

const SALES_STAGE_RANK: Record<SalesStage, number> = {
  catalog: 1,
  catalog_sent: 1,
  address_ask: 2,
  address_confirm: 3,
  payment_link_sent: 4,
}

/** True for stages that mean the customer is explicitly buying. */
export function isCheckoutStage(stage: SalesStage | null): boolean {
  return stage !== null && SALES_STAGE_RANK[stage] >= 2
}

export interface SessionMessage {
  id: string
  senderType: string | null
  contentType: string | null
  contentText: string | null
  templateName: string | null
  createdAt: string
}

/**
 * The strongest sales stage among OUR messages in the current session
 * — those sent after (the customer's last message − sessionHours).
 * Close-nudges and our own re-engagement sends are follow-ups, not
 * stages, so they are ignored. `null` = we never showed products or
 * moved toward checkout in this session.
 */
export function findSalesStage(
  messages: readonly SessionMessage[],
  opts: {
    lastCustomerAt: string
    sessionHours?: number
    /** message ids of close-nudges we sent (ledger) */
    ignoreMessageIds: ReadonlySet<string>
    /** bodies of our freeform re-engagement stages */
    ignoreTexts: ReadonlySet<string>
    /** template names of our re-engagement stages */
    stageTemplateNames: ReadonlySet<string>
  },
): SalesStage | null {
  const since =
    new Date(opts.lastCustomerAt).getTime() - (opts.sessionHours ?? 24) * 3_600_000
  let best: SalesStage | null = null
  for (const m of messages) {
    if (m.senderType === 'customer') continue
    if (new Date(m.createdAt).getTime() < since) continue
    if (opts.ignoreMessageIds.has(m.id)) continue
    const text = (m.contentText ?? '').trim()
    if (m.contentType === 'template') {
      // Our own re-engagement template is a follow-up, anything else
      // is transactional — neither is a sales stage.
      continue
    }
    if (m.contentType === 'text' && text && opts.ignoreTexts.has(text)) continue
    let stage: SalesStage | null = null
    if (m.contentType === 'interactive') stage = 'catalog'
    else if (m.contentType === 'text') stage = detectCloseStage(text)
    if (stage && (!best || SALES_STAGE_RANK[stage] > SALES_STAGE_RANK[best])) best = stage
  }
  return best
}

export interface ThreadSnapshot {
  conversationStatus: string | null
  aiAutoreplyDisabled: boolean | null
  /** From findSalesStage(); null = support-only thread. */
  salesStage: SalesStage | null
  /** From detectRecentCustomer(); ordered within the window. */
  recentCustomer: boolean
  /** From isSupportSession(): latest intent is about an existing order. */
  supportSession?: boolean
  /** Most recent message on the thread, any sender. */
  lastMessage: {
    senderType: string | null
    contentType: string | null
    templateName: string | null
  } | null
  /** ISO timestamp of the customer's most recent message. */
  lastCustomerMessageAt: string | null
}

export type SkipReason =
  | 'not_open'
  | 'ai_paused'
  | 'no_customer_message'
  | 'awaiting_our_reply'
  | 'transactional_flow'
  | 'no_sales_stage'
  | 'recent_customer'
  | 'support_session'
  | 'too_old'

export type ThreadVerdict =
  | { eligible: true; hoursSince: number }
  | { eligible: false; reason: SkipReason }

export function evaluateThread(
  snap: ThreadSnapshot,
  opts: {
    now: number
    maxAgeHours: number
    /** Template names this account's own re-engagement stages send. */
    stageTemplateNames: ReadonlySet<string>
  },
): ThreadVerdict {
  if (snap.conversationStatus !== 'open') {
    return { eligible: false, reason: 'not_open' }
  }
  if (snap.aiAutoreplyDisabled) {
    return { eligible: false, reason: 'ai_paused' }
  }
  if (!snap.lastCustomerMessageAt) {
    return { eligible: false, reason: 'no_customer_message' }
  }
  const last = snap.lastMessage
  if (!last || last.senderType === 'customer') {
    return { eligible: false, reason: 'awaiting_our_reply' }
  }
  if (
    last.contentType === 'template' &&
    !(last.templateName && opts.stageTemplateNames.has(last.templateName))
  ) {
    return { eligible: false, reason: 'transactional_flow' }
  }
  if (snap.supportSession) {
    return { eligible: false, reason: 'support_session' }
  }
  if (!snap.salesStage) {
    return { eligible: false, reason: 'no_sales_stage' }
  }
  if (snap.recentCustomer && !isCheckoutStage(snap.salesStage)) {
    return { eligible: false, reason: 'recent_customer' }
  }
  const hoursSince =
    (opts.now - new Date(snap.lastCustomerMessageAt).getTime()) / 3_600_000
  if (!Number.isFinite(hoursSince) || hoursSince >= opts.maxAgeHours) {
    return { eligible: false, reason: 'too_old' }
  }
  return { eligible: true, hoursSince }
}

/** Local hour (0–23) of `at` in `timeZone`. */
export function localHour(at: Date, timeZone: string): number {
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(at)
  return Number(text) % 24
}

/**
 * True inside [start, end) on a 24h clock. Wraps past midnight, so
 * (22, 8) means 22:00 through 07:59. start === end disables it.
 */
export function isQuietHour(
  at: Date,
  timeZone: string,
  start: number,
  end: number,
): boolean {
  if (start === end) return false
  const h = localHour(at, timeZone)
  return start < end ? h >= start && h < end : h >= start || h < end
}
