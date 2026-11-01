import { describe, expect, it } from 'vitest'
import { cachedSystemBlock, usageFrom } from './anthropic'
import { addUsage } from './shared'
import { REPLY_CONTEXT_HEADING, buildSystemPrompt } from '../defaults'

describe('cachedSystemBlock', () => {
  it('caches the rules and the reply context as separate blocks', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', customerName: 'Surya', knowledge: ['kb'] })
    const blocks = cachedSystemBlock(prompt)
    expect(blocks).toHaveLength(2)
    expect(blocks.every((b) => b.cache_control?.type === 'ephemeral')).toBe(true)
    expect(blocks[1].text.startsWith(REPLY_CONTEXT_HEADING)).toBe(true)
    expect(blocks[0].text).not.toContain('Surya')
    expect(`${blocks[0].text}\n\n${blocks[1].text}`).toBe(prompt)
  })

  it('keeps a prompt without reply context as one block', () => {
    expect(cachedSystemBlock('Reply with OK.')).toEqual([
      { type: 'text', text: 'Reply with OK.', cache_control: { type: 'ephemeral' } },
    ])
  })
})

describe('usageFrom', () => {
  it('reads cached prompt tokens apart from input_tokens', () => {
    const usage = usageFrom({
      usage: { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 2000, cache_read_input_tokens: 8000 },
    })
    expect(usage).toEqual({ promptTokens: 900, completionTokens: 300, totalTokens: 1200, cacheWriteTokens: 2000, cacheReadTokens: 8000 })
  })

  it('sums cache tokens across tool rounds', () => {
    const round1 = usageFrom({ usage: { input_tokens: 900, output_tokens: 50, cache_creation_input_tokens: 10000 } })
    const round2 = usageFrom({ usage: { input_tokens: 400, output_tokens: 250, cache_read_input_tokens: 10000 } })
    expect(addUsage(round1, round2)).toEqual({
      promptTokens: 1300,
      completionTokens: 300,
      totalTokens: 1600,
      cacheWriteTokens: 10000,
      cacheReadTokens: 10000,
    })
  })
})
