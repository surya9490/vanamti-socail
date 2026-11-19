import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// "Has a newer customer message superseded this AI dispatch?"
//
// Every customer text starts its own dispatch, so a burst like
// "Ues" / "Ues" / "Yes" runs three in parallel. Only the dispatch
// for the LAST message may reply — the others stand down.
//
// "Last" is decided by message order, never by the server clock.
// `messages.created_at` is the WhatsApp send time (whole seconds),
// and Meta delivers it a few seconds later. Live 2026-11-19: "Yes"
// was sent at :24 but reached us at :27; the dispatch for the
// earlier "Ues" had started at :24.58 and checked for messages
// newer than that — "Yes" (:24.00) didn't count, both replied, and
// the customer got two payment links for one order.
// ============================================================

export interface OwnInbound {
  id: string
  created_at: string
}

/** The stored row of the inbound this dispatch answers (by WhatsApp id). */
export async function loadOwnInbound(
  db: SupabaseClient,
  conversationId: string,
  whatsappMessageId: string
): Promise<OwnInbound | null> {
  const { data } = await db
    .from('messages')
    .select('id, created_at')
    .eq('conversation_id', conversationId)
    .eq('message_id', whatsappMessageId)
    .maybeSingle()
  const row = data as OwnInbound | null
  return row?.id && row.created_at ? row : null
}

/**
 * True when the customer has sent a text after `own`. Same-second
 * messages tie-break on id, so exactly one dispatch of a burst
 * survives. Only TEXT counts: a voice note or photo doesn't start an
 * AI reply of its own, so it must not cancel this one.
 *
 * `fallbackSince` is used only if the own row couldn't be loaded:
 * then any text stamped after it counts as newer (the old behaviour).
 */
export async function hasNewerCustomerText(
  db: SupabaseClient,
  conversationId: string,
  own: OwnInbound | null,
  fallbackSince: string
): Promise<boolean> {
  const since = own?.created_at ?? fallbackSince
  const { data } = await db
    .from('messages')
    .select('id, created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .eq('content_type', 'text')
    .gte('created_at', since)
    .limit(50)
  const sinceMs = Date.parse(since)
  return ((data ?? []) as OwnInbound[]).some((m) => {
    if (own && m.id === own.id) return false
    const ms = Date.parse(m.created_at)
    if (ms !== sinceMs) return ms > sinceMs
    return own ? m.id > own.id : false
  })
}
