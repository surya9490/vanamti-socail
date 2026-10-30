// Per-customer daily nudge cap, shared by both follow-up crons
// (close-nudge and re-engagement). Each cron keeps its own ledger and
// never looks at the other's, so without this a silent lead could get
// two address nudges, two confirm nudges and then the 3h check-in, all
// in one afternoon. The cap counts every follow-up either cron sent the
// contact in the last 24h, across all of their conversations.
import type { SupabaseClient } from '@supabase/supabase-js'

/** Most follow-ups (close-nudges + re-engagement sends combined) any
 *  one contact receives in a rolling 24h. User rule, 2026-10-17. */
export const MAX_NUDGES_PER_DAY = 2

const WINDOW_MS = 24 * 3_600_000

export interface NudgeBudget {
  /** Follow-ups sent in the last 24h; null when the lookup failed. */
  sent: number | null
  /** True at the cap, and when the lookup failed: skipping one nudge
   *  is cheap, a third one is the spam this cap exists to stop. */
  capReached: boolean
}

export async function fetchNudgeBudget(
  db: SupabaseClient,
  contactId: string,
  now: number,
): Promise<NudgeBudget> {
  const since = new Date(now - WINDOW_MS).toISOString()
  const unknown: NudgeBudget = { sent: null, capReached: true }
  try {
    // Close-nudges are logged per conversation, re-engagement sends per
    // contact — resolve the contact's conversations first.
    const { data: convRows, error: convErr } = await db
      .from('conversations')
      .select('id')
      .eq('contact_id', contactId)
    if (convErr) {
      console.warn('[nudge-cap] conversations lookup failed:', convErr.message)
      return unknown
    }
    const convIds = ((convRows ?? []) as { id: string }[]).map((r) => r.id)

    const [closeRes, reengRes] = await Promise.all([
      convIds.length === 0
        ? Promise.resolve({ count: 0, error: null })
        : db
            .from('conversation_close_nudges')
            .select('id', { count: 'exact', head: true })
            .in('conversation_id', convIds)
            .gte('sent_at', since),
      db
        .from('contact_re_engagement_sends')
        .select('contact_id', { count: 'exact', head: true })
        .eq('contact_id', contactId)
        .gte('sent_at', since),
    ])
    if (closeRes.error || reengRes.error) {
      console.warn(
        '[nudge-cap] ledger count failed:',
        (closeRes.error ?? reengRes.error)?.message,
      )
      return unknown
    }
    const sent = (closeRes.count ?? 0) + (reengRes.count ?? 0)
    return { sent, capReached: sent >= MAX_NUDGES_PER_DAY }
  } catch (err) {
    console.warn('[nudge-cap] lookup threw:', err instanceof Error ? err.message : err)
    return unknown
  }
}
