// Server half of closing.ts: did the customer turn us down? Used by the
// close-nudge cron; the re-engagement cron derives the same verdict from
// the session it already loads.
import type { SupabaseClient } from '@supabase/supabase-js'
import { customerDeclined } from './closing'

export async function fetchCustomerDeclined(
  db: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('messages')
      .select('content_text')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .eq('content_type', 'text')
      .order('created_at', { ascending: false })
      .limit(10)
    if (error) throw new Error(error.message)
    return customerDeclined(((data ?? []) as { content_text: string | null }[]).map((m) => m.content_text))
  } catch (err) {
    // Unknown → treat as declined: a missed nudge costs nothing, a nudge
    // after a "no" costs the customer.
    console.warn('[closing] decline lookup failed:', err instanceof Error ? err.message : err)
    return true
  }
}
