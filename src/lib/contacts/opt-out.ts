// ============================================================
// Marketing opt-out (STOP / START) — single source of truth.
//
// Meta does not handle STOP for you (unlike SMS aggregators): the
// business detects the keyword, stops sending, and confirms. This
// module owns all three concerns:
//
//   1. detection  — matchOptOutKeyword() on inbound text and
//                   interactive button payloads (webhook calls it);
//   2. state      — contacts.opted_out_at (migration 027), set /
//                   cleared via setContactOptOut();
//   3. exclusion  — loadOptedOutPhoneSuffixes() + isPhoneOptedOut()
//                   give every MARKETING send path a hard filter at
//                   send time (broadcasts, public-API sends).
//
// Scope rule: opting out silences *marketing* only. Utility sends
// (order updates, codes the customer requested) and free-form
// replies inside the 24h service window continue — the confirmation
// copy says exactly that.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

export type OptOutAction = 'stop' | 'start'

// Whole-message matches only (after normalization) — conservative on
// purpose so "please don't stop my order" never triggers an opt-out.
const STOP_PHRASES = new Set([
  'stop',
  'unsubscribe',
  'unsubscribe me',
  'opt out',
  'optout',
  'opt-out',
  'stop promotions',
  'stop promo',
  'stop messages',
  'no promotions',
])

const START_PHRASES = new Set([
  'start',
  'subscribe',
  'resubscribe',
  'opt in',
  'optin',
  'opt-in',
  'start promotions',
])

// Interactive button payload ids (we control these when composing
// templates — put e.g. `optout` on the quick-reply button).
const STOP_PAYLOADS = new Set(['stop', 'optout', 'opt_out', 'unsubscribe', 'stop_promotions'])
const START_PAYLOADS = new Set(['start', 'optin', 'opt_in', 'subscribe', 'resubscribe'])

/** Lowercase, collapse whitespace, strip surrounding punctuation. */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.!?,;:'"()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Classify an inbound as an opt-out/opt-in request, or null.
 * `interactiveReplyId` (button tap) wins over free text when present.
 */
export function matchOptOutKeyword(
  text: string | null | undefined,
  interactiveReplyId?: string | null,
): OptOutAction | null {
  if (interactiveReplyId) {
    const id = interactiveReplyId.toLowerCase().trim()
    if (STOP_PAYLOADS.has(id)) return 'stop'
    if (START_PAYLOADS.has(id)) return 'start'
  }
  if (text) {
    const normalized = normalizeText(text)
    if (STOP_PHRASES.has(normalized)) return 'stop'
    if (START_PHRASES.has(normalized)) return 'start'
  }
  return null
}

// Sent as free-form text — always inside the 24h window (the STOP
// itself opened it), so no template approval is needed and it's free.
export const OPT_OUT_CONFIRMATION =
  "You've been unsubscribed and won't receive offers from us anymore. " +
  'Order updates will still reach you. Reply START anytime to hear from us again.'

export const OPT_IN_CONFIRMATION =
  "Welcome back! You'll receive our offers and updates again. Reply STOP anytime to unsubscribe."

/** Set (stop) or clear (start) the opt-out flag on a contact row. */
export async function setContactOptOut(
  supabase: SupabaseClient,
  contactId: string,
  action: OptOutAction,
): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase
    .from('contacts')
    .update({
      opted_out_at: action === 'stop' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)
  return { error }
}

/**
 * Suffix key used for send-time exclusion matching. Last 10 digits —
 * an Indian mobile with or without the 91 country code (or a trunk 0)
 * collapses to the same key. Shorter numbers use all their digits.
 * Over-matching is the SAFE direction for an opt-out filter.
 */
export function phoneSuffixKey(phone: string): string {
  const digits = normalizePhone(phone)
  return digits.length > 10 ? digits.slice(-10) : digits
}

/**
 * Load the suffix keys of every opted-out contact in an account.
 * One indexed query (partial index from migration 027) per send batch.
 */
export async function loadOptedOutPhoneSuffixes(
  supabase: SupabaseClient,
  accountId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('contacts')
    .select('phone')
    .eq('account_id', accountId)
    .not('opted_out_at', 'is', null)

  if (error) {
    // Fail CLOSED for marketing sends would block every campaign on a
    // transient DB error; fail OPEN risks messaging an opted-out user.
    // We fail open but log loudly — the hard guarantee remains the
    // webhook's flag + this filter on the next healthy run.
    console.error('[opt-out] failed to load opted-out contacts:', error.message)
    return new Set()
  }

  const suffixes = new Set<string>()
  for (const row of data ?? []) {
    if (row.phone) suffixes.add(phoneSuffixKey(row.phone))
  }
  return suffixes
}

/** Is `phone` in the opted-out set loaded above? */
export function isPhoneOptedOut(optedOut: Set<string>, phone: string): boolean {
  if (optedOut.size === 0) return false
  return optedOut.has(phoneSuffixKey(phone))
}
