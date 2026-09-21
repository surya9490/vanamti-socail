// Server-side half of recent-customer detection: load the window of
// messages for a conversation and run the pure detector. Shared by the
// auto-reply pipeline and both follow-up crons so all three agree on
// who is a recent customer.
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  detectRecentCustomer,
  recentCustomerWindowDays,
  type RecentCustomerMessage,
  type RecentCustomerVerdict,
} from './recent-customer'

export async function fetchRecentCustomerVerdict(
  db: SupabaseClient,
  conversationId: string,
  now: number,
): Promise<RecentCustomerVerdict & { windowDays: number }> {
  const windowDays = recentCustomerWindowDays()
  const since = new Date(now - windowDays * 86_400_000).toISOString()
  const notRecent = { recent: false as const, signal: null, at: null, windowDays }
  try {
    const { data, error } = await db
      .from('messages')
      .select('created_at, content_type, template_name, content_text')
      .eq('conversation_id', conversationId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) {
      // Unknown history → treat as not-recent so the reply still flows;
      // the crons have their own rails. Never let this lookup take the
      // reply down with it.
      console.warn('[recent-customer] history query failed:', error.message)
      return notRecent
    }
    const verdict = detectRecentCustomer((data ?? []) as RecentCustomerMessage[], { now, windowDays })
    return { ...verdict, windowDays }
  } catch (err) {
    console.warn('[recent-customer] history lookup threw:', err instanceof Error ? err.message : err)
    return notRecent
  }
}
