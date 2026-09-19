import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().in().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('includes template sends as assistant turns with a named prefix', async () => {
    // Regression: a customer replying "Very good 👍" to a review_request
    // template must see that template as the preceding assistant turn —
    // otherwise the model treats the reply as a cold opener and fires
    // the catalog instead of asking for the review.
    const rows = [
      { sender_type: 'customer', content_type: 'text', content_text: 'Very good 👍', template_name: null },
      {
        sender_type: 'agent',
        content_type: 'template',
        content_text: 'Hi IYERG, we hope you are enjoying your Iyappa ghee! Please leave a review.',
        template_name: 'review_request',
      },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      {
        role: 'assistant',
        content:
          '[Sent template "review_request"] Hi IYERG, we hope you are enjoying your Iyappa ghee! Please leave a review.',
      },
      { role: 'user', content: 'Very good 👍' },
    ])
  })

  it('uses a generic prefix for a template row with no template_name', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_type: 'template', content_text: 'body', template_name: null }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: '[Sent template] body' }])
  })

  it('does not prefix plain text turns', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_type: 'text', content_text: 'plain', template_name: null }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'plain' }])
  })
})
