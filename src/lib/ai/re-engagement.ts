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
//
// Plus a quiet-hours window (default 22:00–08:00 Asia/Kolkata): a
// nudge at 1 am reads as spam and earns blocks.
// ============================================================

export interface ThreadSnapshot {
  conversationStatus: string | null
  aiAutoreplyDisabled: boolean | null
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
