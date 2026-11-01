import { describe, expect, it } from 'vitest'
import { REPLY_CONTEXT_HEADING, buildSystemPrompt } from './defaults'

const base = { userPrompt: 'We sell honey and ghee.', mode: 'auto_reply' as const }
const rules = (prompt: string) => prompt.slice(0, prompt.indexOf(REPLY_CONTEXT_HEADING))

describe('buildSystemPrompt', () => {
  it('keeps everything above the reply context identical across customers and messages', () => {
    const a = buildSystemPrompt({ ...base, customerName: 'Surya', silenceGapDays: 0, customerIntent: 'ambiguous', knowledge: ['Iyappa ghee is hand-boiled.'] })
    const b = buildSystemPrompt({
      ...base,
      customerName: 'Priya',
      recentCustomer: { daysAgo: 2, windowDays: 7 },
      supportSession: true,
      knowledge: ['Forest honey is raw.'],
    })
    expect(rules(a)).toBe(rules(b))
    expect(rules(a)).toContain('We sell honey and ghee.')
    expect(rules(a)).not.toMatch(
      /Surya|Priya|THIS MESSAGE IS UNCLEAR|EXISTING CUSTOMER — SUPPORT MODE|THIS CONVERSATION IS CUSTOMER CARE|first message in this conversation|\[1\] /,
    )
  })

  it('puts the customer, their intent, the greeting, support mode and KB after the heading', () => {
    const prompt = buildSystemPrompt({
      ...base,
      customerName: 'Surya',
      silenceGapDays: 3,
      recentCustomer: { daysAgo: 1, windowDays: 7 },
      customerIntent: 'future_order',
      knowledge: ['Iyappa ghee is hand-boiled.'],
    })
    const context = prompt.slice(prompt.indexOf(REPLY_CONTEXT_HEADING))
    expect(prompt.indexOf(REPLY_CONTEXT_HEADING)).toBeGreaterThan(0)
    for (const part of [
      "The customer's name is Surya.",
      'THE CUSTOMER SAYS THEY WILL ORDER LATER',
      'silent for 3 day(s)',
      'overrides the product-discovery, greeting and sales rules above',
      '[1] Iyappa ghee is hand-boiled.',
    ]) {
      expect(context).toContain(part)
    }
  })

  it('has no reply context when there is nothing per-reply', () => {
    expect(buildSystemPrompt({ userPrompt: null, mode: 'draft' })).not.toContain(REPLY_CONTEXT_HEADING)
    expect(buildSystemPrompt({ userPrompt: null, mode: 'draft', knowledge: ['x'] })).toContain(REPLY_CONTEXT_HEADING)
  })
})
