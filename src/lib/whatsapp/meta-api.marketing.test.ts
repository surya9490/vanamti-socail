import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageTemplate } from '@/types'
import { sendTemplateMessage } from './meta-api'

/**
 * Marketing templates go through Meta's Marketing Messages API
 * (/marketing_messages); everything else stays on /messages. A refused
 * /marketing_messages request falls back to /messages.
 */

interface Call {
  url: string
  body: Record<string, unknown>
}
let calls: Call[] = []

function ok(id: string) {
  return new Response(JSON.stringify({ messages: [{ id }] }), { status: 200 })
}

function stubFetch(responder: (url: string) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return responder(url)
    })
  )
}

function tpl(category: string): MessageTemplate {
  return {
    id: 't1',
    user_id: 'u1',
    name: 'reorder_reminder_v1',
    category: category as MessageTemplate['category'],
    language: 'en',
    body_text: 'Hi {{1}}',
    created_at: '2026-11-22T00:00:00Z',
  }
}

const BASE = {
  phoneNumberId: 'pn-1',
  accessToken: 'tok',
  to: '918886999441',
  templateName: 'reorder_reminder_v1',
  language: 'en',
  params: ['Asha'],
}

beforeEach(() => {
  calls = []
  stubFetch((url) => ok(url.endsWith('/marketing_messages') ? 'wamid.MM' : 'wamid.CLOUD'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('marketing templates use /marketing_messages', () => {
  it('posts the same payload plus product_policy to v24.0 marketing_messages', async () => {
    const r = await sendTemplateMessage({ ...BASE, template: tpl('Marketing') })
    expect(r.messageId).toBe('wamid.MM')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://graph.facebook.com/v24.0/pn-1/marketing_messages')
    expect(calls[0].body).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '918886999441',
      type: 'template',
      template: { name: 'reorder_reminder_v1', language: { code: 'en' } },
      product_policy: 'CLOUD_API_FALLBACK',
    })
  })

  it('matches the category in any case', async () => {
    await sendTemplateMessage({ ...BASE, template: tpl('MARKETING') })
    expect(calls[0].url).toMatch(/\/marketing_messages$/)
  })

  it('falls back to /messages when marketing_messages refuses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch((url) =>
      url.endsWith('/marketing_messages')
        ? new Response(JSON.stringify({ error: { message: 'not onboarded', code: 100 } }), { status: 400 })
        : ok('wamid.CLOUD')
    )
    const r = await sendTemplateMessage({ ...BASE, template: tpl('Marketing') })
    expect(r.messageId).toBe('wamid.CLOUD')
    expect(calls.map((c) => c.url)).toEqual([
      'https://graph.facebook.com/v24.0/pn-1/marketing_messages',
      'https://graph.facebook.com/v21.0/pn-1/messages',
    ])
    expect(calls[1].body).not.toHaveProperty('product_policy')
  })

  it('throws the /messages error when both routes refuse', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'bad param', code: 132000 } }), { status: 400 }))
    await expect(sendTemplateMessage({ ...BASE, template: tpl('Marketing') })).rejects.toThrow('bad param')
    expect(calls).toHaveLength(2)
  })
})

describe('everything else stays on /messages', () => {
  const cases: [string, Parameters<typeof sendTemplateMessage>[0]][] = [
    ['a utility template', { ...BASE, template: tpl('Utility') }],
    ['no template row', { ...BASE }],
    ['a username (BSUID) recipient', { ...BASE, to: 'US.13491208655302741918', template: tpl('Marketing') }],
    ['a reply quoting a message', { ...BASE, template: tpl('Marketing'), contextMessageId: 'wamid.PREV' }],
  ]
  for (const [label, args] of cases) {
    it(label, async () => {
      const r = await sendTemplateMessage(args)
      expect(r.messageId).toBe('wamid.CLOUD')
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/pn-1/messages')
      expect(calls[0].body).not.toHaveProperty('product_policy')
    })
  }

  it('WHATSAPP_MARKETING_MESSAGES_API=off turns it off', async () => {
    vi.stubEnv('WHATSAPP_MARKETING_MESSAGES_API', 'off')
    await sendTemplateMessage({ ...BASE, template: tpl('Marketing') })
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/pn-1/messages')
  })
})
