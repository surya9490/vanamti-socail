import { describe, it, expect, beforeEach } from 'vitest'
import { pickModelForAutoReply } from './router'
import type { AiConfig } from './types'

const SONNET = 'claude-sonnet-5'
const HAIKU = 'claude-haiku-4-5-20251001'

function cfg(overrides: Partial<Pick<AiConfig, 'provider' | 'model'>> = {}) {
  return {
    provider: 'anthropic',
    model: SONNET,
    ...overrides,
  } as Pick<AiConfig, 'provider' | 'model'>
}

describe('pickModelForAutoReply — provider gating', () => {
  it('always returns config.model for openai', () => {
    const picked = pickModelForAutoReply({
      config: cfg({ provider: 'openai', model: 'gpt-5.4-mini' }),
      latestUserMessage: 'hello',
      hasCreateOrderTool: false,
    })
    expect(picked).toBe('gpt-5.4-mini')
  })

  it('always returns config.model for gemini', () => {
    const picked = pickModelForAutoReply({
      config: cfg({ provider: 'gemini', model: 'gemini-2.5-flash' }),
      latestUserMessage: 'hello',
      hasCreateOrderTool: false,
    })
    expect(picked).toBe('gemini-2.5-flash')
  })
})

describe('pickModelForAutoReply — Haiku-safe cases (fast model wins)', () => {
  it('routes a plain greeting to Haiku', () => {
    expect(
      pickModelForAutoReply({
        config: cfg(),
        latestUserMessage: 'hi',
        hasCreateOrderTool: true,
      }),
    ).toBe(HAIKU)
  })

  it('routes generic product browsing to Haiku', () => {
    expect(
      pickModelForAutoReply({
        config: cfg(),
        latestUserMessage: 'what all products do you have',
        hasCreateOrderTool: true,
      }),
    ).toBe(HAIKU)
  })

  it('routes a "do you have X" question to Haiku', () => {
    expect(
      pickModelForAutoReply({
        config: cfg(),
        latestUserMessage: 'do you have ghee',
        hasCreateOrderTool: true,
      }),
    ).toBe(HAIKU)
  })

  it('routes a short affirmative to Haiku when the create_order tool is NOT enabled', () => {
    // Without the draft-order tool there's no "close" step to
    // fumble, so Haiku can handle the acknowledgement.
    expect(
      pickModelForAutoReply({
        config: cfg(),
        latestUserMessage: 'yes',
        hasCreateOrderTool: false,
      }),
    ).toBe(HAIKU)
  })
})

describe('pickModelForAutoReply — Sonnet-forced cases (default wins)', () => {
  it('escalates short affirmatives to Sonnet when the tool IS enabled', () => {
    // With the tool enabled, "yes" is the trigger to call
    // create_draft_order — that's exactly the moment we want
    // Sonnet's better tool orchestration.
    for (const affirmative of ['yes', 'ok', 'haan', 'sure', 'ji', '👍']) {
      expect(
        pickModelForAutoReply({
          config: cfg(),
          latestUserMessage: affirmative,
          hasCreateOrderTool: true,
        }),
      ).toBe(SONNET)
    }
  })

  it('escalates handoff keywords to Sonnet', () => {
    for (const msg of [
      'i want a refund',
      'this is a complaint',
      'connect me to a human',
      'i want to cancel my order',
      'this is fraud',
    ]) {
      expect(
        pickModelForAutoReply({
          config: cfg(),
          latestUserMessage: msg,
          hasCreateOrderTool: false,
        }),
      ).toBe(SONNET)
    }
  })

  it('escalates order-placement keywords to Sonnet', () => {
    for (const msg of [
      'please place my order',
      'can you place order for me',
      'my address is 3-225 Mallisala',
      'payment please',
      'ready to pay',
    ]) {
      expect(
        pickModelForAutoReply({
          config: cfg(),
          latestUserMessage: msg,
          hasCreateOrderTool: true,
        }),
      ).toBe(SONNET)
    }
  })

  it('escalates messages with a 6-digit PIN code to Sonnet', () => {
    expect(
      pickModelForAutoReply({
        config: cfg(),
        latestUserMessage: 'surya 3-225 jaggampeta 533435',
        hasCreateOrderTool: true,
      }),
    ).toBe(SONNET)
  })

  it('escalates long messages (>200 chars) to Sonnet', () => {
    const longMsg = 'a'.repeat(220)
    expect(
      pickModelForAutoReply({
        config: cfg(),
        latestUserMessage: longMsg,
        hasCreateOrderTool: true,
      }),
    ).toBe(SONNET)
  })

  it('escalates empty / whitespace-only messages to Sonnet (no signal)', () => {
    expect(
      pickModelForAutoReply({
        config: cfg(),
        latestUserMessage: '',
        hasCreateOrderTool: true,
      }),
    ).toBe(SONNET)
    expect(
      pickModelForAutoReply({
        config: cfg(),
        latestUserMessage: '   ',
        hasCreateOrderTool: true,
      }),
    ).toBe(SONNET)
  })
})

describe('pickModelForAutoReply — self-Haiku account never gets bumped', () => {
  it('returns config.model unchanged when the account is already on Haiku', () => {
    // Operator opted into Haiku globally; we don't "upgrade" them
    // to Sonnet without their consent.
    expect(
      pickModelForAutoReply({
        config: cfg({ model: HAIKU }),
        latestUserMessage: 'please place my order',
        hasCreateOrderTool: true,
      }),
    ).toBe(HAIKU)
  })
})

describe('pickModelForAutoReply — env override', () => {
  const originalEnv = process.env.AI_FAST_MODEL_ANTHROPIC

  beforeEach(() => {
    process.env.AI_FAST_MODEL_ANTHROPIC = originalEnv
  })

  it('respects AI_FAST_MODEL_ANTHROPIC env var', () => {
    process.env.AI_FAST_MODEL_ANTHROPIC = 'claude-fable-5'
    expect(
      pickModelForAutoReply({
        config: cfg(),
        latestUserMessage: 'hi',
        hasCreateOrderTool: true,
      }),
    ).toBe('claude-fable-5')
    process.env.AI_FAST_MODEL_ANTHROPIC = originalEnv
  })
})
