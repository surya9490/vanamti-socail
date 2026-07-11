import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration } from './generate'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    enabledTools: [],
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
    // The Gemini adapter peeks the error body via `res.clone()` before
    // deferring to the shared mapper — hand back a fresh readable copy.
    clone: () => errResponse(status, json),
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      usage: null,
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      handoff: true,
      usage: null,
    })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      usage: null,
    })
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      handoff: false,
      usage,
    })
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      handoff: false,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })
})

describe('generateReply — Gemini', () => {
  it('calls generateContent with the api-key header and parses candidate text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        candidates: [{ content: { parts: [{ text: 'Hi there!' }], role: 'model' } }],
        usageMetadata: {
          promptTokenCount: 30,
          candidatesTokenCount: 6,
          totalTokenCount: 36,
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIza-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      // Gemini reports a total — normalizeUsage uses it as-is.
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('generativelanguage.googleapis.com')
    expect(url).toContain('gemini-2.5-flash:generateContent')
    expect(opts.headers['x-goog-api-key']).toBe('AIza-x')
    // system prompt travels in system_instruction, not contents.
    const body = JSON.parse(opts.body)
    expect(body.system_instruction.parts[0].text).toBe('sys')
  })

  it('maps a 400 "API key not valid" to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(400, {
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
          },
        }),
      ),
    )

    await expect(
      generateReply({
        config: config({ provider: 'gemini' }),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty response (no candidates)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ candidates: [] })))
    await expect(
      generateReply({
        config: config({ provider: 'gemini' }),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })

  it('maps assistant turns to model and starts the transcript on the customer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'gemini' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    // Leading assistant turn dropped; remaining user turn maps to role 'user'.
    expect(body.contents).toHaveLength(1)
    expect(body.contents[0].role).toBe('user')
    expect(body.contents[0].parts[0].text).toBe('Hi')
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          candidates: [{ content: { parts: [{ text: '[[HANDOFF]]' }], role: 'model' } }],
        }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'gemini' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want a human' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })
})

describe('generateReply — Gemini tool calling', () => {
  const fakeTool = {
    name: 'order_lookup',
    label: 'Order lookup',
    description: 'Look up an order',
    parameters: { type: 'OBJECT' as const, properties: {}, required: [] },
    run: vi.fn(async () => 'Order #1024 is out for delivery.'),
  }
  const toolContext = {
    db: {} as never,
    accountId: 'a',
    conversationId: 'c',
    contactId: 'ct',
    contactPhone: '+1',
  }

  it('runs the tool, feeds the result back, and returns the final text', async () => {
    const fetchMock = vi
      .fn()
      // Round 1: the model asks to call the tool.
      .mockResolvedValueOnce(
        okResponse({
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'order_lookup', args: { order_number: '1024' } } },
                ],
                role: 'model',
              },
            },
          ],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, totalTokenCount: 24 },
        }),
      )
      // Round 2: with the tool result in hand, it answers.
      .mockResolvedValueOnce(
        okResponse({
          candidates: [
            { content: { parts: [{ text: 'Your order is out for delivery! 📦' }], role: 'model' } },
          ],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 8, totalTokenCount: 38 },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'gemini' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: "Where's my order 1024?" }],
      tools: [fakeTool],
      toolContext,
    })

    expect(res.text).toBe('Your order is out for delivery! 📦')
    // Tool executed once with the model's args + our trusted context.
    expect(fakeTool.run).toHaveBeenCalledWith({ order_number: '1024' }, toolContext)
    // Two round-trips: call + answer.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Usage is summed across rounds.
    expect(res.usage).toEqual({ promptTokens: 50, completionTokens: 12, totalTokens: 62 })
    // Round 2's request carried the functionResponse back to the model.
    const round2Body = JSON.parse(fetchMock.mock.calls[1][1].body)
    const lastTurn = round2Body.contents[round2Body.contents.length - 1]
    expect(lastTurn.parts[0].functionResponse.name).toBe('order_lookup')
    expect(lastTurn.parts[0].functionResponse.response.result).toContain('out for delivery')
    // The tool declarations were offered to the model.
    expect(round2Body.tools[0].functionDeclarations[0].name).toBe('order_lookup')
  })

  it('ignores tools for non-Gemini providers (single-shot)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'Hi' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [fakeTool],
      toolContext,
    })
    expect(res.text).toBe('Hi')
    expect(fakeTool.run).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
