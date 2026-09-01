import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text')
    .eq('conversation_id', conversationId)
    .eq('content_type', 'text')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  const chat = rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: (m.sender_type === 'customer' ? 'user' : 'assistant') as
        | 'user'
        | 'assistant',
      content: m.content_text!.trim(),
    }))

  // Collapse consecutive identical CUSTOMER turns. When auto-reply
  // is paused (handoff), silent handoffs leave no assistant turn
  // between repeated customer sends of the same question. The model
  // then sees "user: X / user: X / user: X" and reads it as
  // escalation ("customer needs a human, they've asked 3 times") —
  // which then loops into another handoff on resume. Deduping
  // gives the model the clean "user: X" it should have seen if the
  // AI had responded normally the first time.
  //
  // Only collapses IDENTICAL consecutive USER turns; different
  // messages (even just wording variations) stay in the transcript
  // untouched — those carry real conversational signal.
  const collapsed: ChatMessage[] = []
  for (const m of chat) {
    const prev = collapsed[collapsed.length - 1]
    if (prev && prev.role === 'user' && m.role === 'user' && prev.content === m.content) {
      continue
    }
    collapsed.push(m)
  }
  return collapsed
}
