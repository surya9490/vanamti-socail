import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  template_name: string | null
}

/**
 * Fetch the last N text + template messages of a conversation and map
 * them to the provider-neutral chat shape. Customer messages become
 * `user`; agent and bot messages become `assistant`.
 *
 * Templates ARE included: we store the rendered body in content_text,
 * and the model needs to see them. Without them, a customer replying
 * "Very good 👍" to a review_request template looked like a cold
 * opener with no preceding assistant turn — so the bot fired the
 * catalog instead of asking for the review. Template turns carry a
 * short bracketed prefix naming the template so the model can tell a
 * proactive blast (review ask, abandoned cart, welcome code) from a
 * mid-conversation reply.
 *
 * Media and interactive sends stay excluded: media has no text, and
 * every catalog/interactive send is immediately followed by a bot text
 * turn that already describes it.
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
    .select('sender_type, content_type, content_text, template_name')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'template'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  const chat = rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => {
      const text = m.content_text!.trim()
      const isTemplate = m.content_type === 'template'
      const prefix =
        isTemplate && m.template_name
          ? `[Sent template "${m.template_name}"] `
          : isTemplate
            ? '[Sent template] '
            : ''
      return {
        role: (m.sender_type === 'customer' ? 'user' : 'assistant') as
          | 'user'
          | 'assistant',
        content: prefix + text,
      }
    })

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

/**
 * Auto-reply only: make the transcript end on the customer. Messages are
 * ordered by Meta's timestamp, but a webhook can land late — live
 * 2026-10-04: "Call me" → "Please" (stamped 03:45:21) reached us after the
 * bot had already answered "Call me" (03:45:23), so the transcript ended
 * on the bot and Anthropic rejected it (400 "must end with a user
 * message") → the thread failed over to a human. The latest customer turn
 * is what this dispatch is answering, and from the bot's side it arrived
 * after that reply — so move it to the end.
 */
export function endOnLatestCustomerTurn(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0 || messages[messages.length - 1].role === 'user') return messages
  let i = messages.length - 1
  while (i >= 0 && messages[i].role !== 'user') i--
  if (i < 0) return messages
  return [...messages.slice(0, i), ...messages.slice(i + 1), messages[i]]
}
