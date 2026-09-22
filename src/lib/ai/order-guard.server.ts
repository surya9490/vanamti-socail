// Server half of the order guard: is this conversation a SUPPORT session?
// Shared by the follow-up crons (close-nudge, re-engagement) so a customer
// asking about an existing order is never nudged to buy. The auto-reply
// pipeline computes the same verdict inline with the same pure helper.
import type { SupabaseClient } from '@supabase/supabase-js'
import { isSupportSession } from './order-guard'
import { fetchRecentCustomerVerdict } from './recent-customer.server'

export async function fetchSupportSession(
  db: SupabaseClient,
  conversationId: string,
  now: number,
): Promise<boolean> {
  try {
    const [{ data }, recent] = await Promise.all([
      db
        .from('messages')
        .select('content_text')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .eq('content_type', 'text')
        .gte('created_at', new Date(now - 14 * 86_400_000).toISOString())
        .order('created_at', { ascending: false })
        .limit(30),
      fetchRecentCustomerVerdict(db, conversationId, now),
    ])
    return isSupportSession(
      ((data ?? []) as { content_text: string | null }[]).map((m) => m.content_text),
      { recentCustomer: recent.recent },
    )
  } catch (err) {
    // Unknown → treat as support: a missed nudge costs nothing, a sales
    // nudge to someone chasing their order costs trust.
    console.warn('[order-guard] support-session lookup failed:', err instanceof Error ? err.message : err)
    return true
  }
}
