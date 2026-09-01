import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    recentAiMessages: [] as { id: string; created_at: string }[],
    recentInbounds: [] as { created_at: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'messages') {
        // Two distinct queries hit `messages`:
        //  1. Cooldown check: .select().eq().eq().gt().limit() — resolves
        //     via `.limit()`, returns `h.state.recentAiMessages`.
        //  2. Silence-gap detection: .select().eq().eq().order().limit()
        //     — resolves via `.limit()` (which is chained AFTER .order()),
        //     returns `h.state.recentInbounds`.
        // We disambiguate on `.order()` — its presence switches the
        // terminal `.limit()` to the silence-gap payload.
        const chain: {
          select: () => typeof chain
          eq: () => typeof chain
          gt: () => typeof chain
          order: () => typeof chain
          limit: () => Promise<{ data: unknown; error: null }>
          _isOrdered: boolean
        } = {
          _isOrdered: false,
          select: () => chain,
          eq: () => chain,
          gt: () => chain,
          order: () => {
            chain._isOrdered = true
            return chain
          },
          limit: () =>
            Promise.resolve({
              data: chain._isOrdered
                ? h.state.recentInbounds
                : h.state.recentAiMessages,
              error: null,
            }),
        }
        return chain
      }
      if (table === 'ai_usage_log') {
        // Budget check: SUM(total_tokens) WHERE contact_id=X AND
        // created_at > 24h ago. Mock always returns 0 spent, so the
        // budget never trips in tests.
        const chain = {
          select: () => chain,
          eq: () => chain,
          gt: () => Promise.resolve({ data: [], error: null }),
        }
        return chain
      }
      // conversations + contacts fallthrough — the auto-reply path
      // reads both with chained .eq() (one or two levels). A recursive
      // eq() that returns the same builder keeps the mock forgiving
      // regardless of how many filters the caller stacks.
      // Data returned by .maybeSingle() depends on the table:
      //   contacts       → contactRow (has `name` for the prompt +
      //                    `phone` for the tool context)
      //   conversations  → conv
      // Table selector persists via a closed-over variable so calls
      // like `.from('contacts').select().eq().eq().maybeSingle()`
      // resolve to the contact row, not the conversation row.
      const isContacts = table === 'contacts'
      type Builder = {
        select: () => Builder
        eq: () => Builder
        maybeSingle: () => Promise<{ data: unknown; error: null }>
      }
      const builder: Builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () =>
          Promise.resolve({
            data: isContacts
              ? { name: 'Test Contact', phone: '+919490790257' }
              : h.state.conv,
            error: null,
          }),
      }
      return {
        ...builder,
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    enabledTools: [],
    defaultLanguage: null,
    ...overrides,
  }
}

beforeEach(() => {
  // Debounce is skipped in tests; production defaults to 8s.
  process.env.AI_MESSAGE_BATCH_WAIT_SECONDS = '0'
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.recentAiMessages = []
  // Default: two customer inbounds 1 second apart → no silence gap.
  // Keeps the "greeting clause" out of the system prompt for the
  // existing tests, so they can keep asserting the base prompt.
  const now = new Date()
  const oneSecondAgo = new Date(now.getTime() - 1000)
  h.state.recentInbounds = [
    { created_at: now.toISOString() },
    { created_at: oneSecondAgo.toISOString() },
  ]
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('sends on the happy path (no atomic slot claim, cap removed)', async () => {
    await dispatchInboundToAiReply(ARGS)
    // The claim_ai_reply_slot RPC is no longer used — the per-
    // conversation cap was removed. No cap-related RPC calls fire.
    expect(h.state.rpcCalls).toEqual([])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('keeps replying past the old cap (per-conversation cap was removed)', async () => {
    // A conversation with ai_reply_count already at 100 (well past
    // the old default cap of 3) still gets a reply — the cap
    // enforcement was removed. Only the 30s cooldown, the
    // ai_autoreply_disabled flag, assigned_agent_id, and the
    // master switch can stop a reply now.
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 100,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation (fresh pause)', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_autoreply_disabled_at: new Date().toISOString(), // just now
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('auto-resumes and replies when auto-reply was paused >24h ago', async () => {
    const oldPause = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_autoreply_disabled_at: oldPause,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('does NOT auto-resume when the disabled_at timestamp is missing', async () => {
    // NULL disabled_at = pre-migration or human-manual pause of
    // unknown age. Safer to keep paused and let a human resume it.
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_autoreply_disabled_at: null,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('replies even when we just replied recently (post-reply cooldown removed)', async () => {
    // Prior behavior: a 30s cooldown after every AI reply skipped
    // any inbound that landed inside the window. That blocked
    // legitimate quick follow-ups (customer answering our question).
    // Burst protection is now the batch-debounce + post-generation
    // race check; the cooldown is gone. A recent AI message in the
    // transcript no longer blocks a fresh reply.
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('skips when a newer customer inbound arrived while generating', async () => {
    // Post-generation race check. Two dispatches for two rapid
    // customer messages: the first one, having already finished
    // generation, should NOT send if the mock now shows a newer
    // customer inbound (i.e. the second dispatch will produce a
    // fuller reply). Prevents double-messaging.
    //
    // The mock's non-ordered messages query returns recentAiMessages
    // — that's how the post-gen check receives its "newer inbound"
    // signal in tests (schema-wise it's customer messages; the mock
    // just repurposes the same field).
    h.state.recentAiMessages = [
      { id: 'newer-customer-msg', created_at: new Date().toISOString() },
    ]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalled() // generation still ran
    expect(h.engineSendText).not.toHaveBeenCalled() // but send was skipped
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})
