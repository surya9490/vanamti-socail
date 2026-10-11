import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/flows/meta-send', () => ({ engineSendRawMessage: vi.fn() }))

import { handleCatalogCart, summarizeGraphMessage } from './whatsapp-pay'

describe('summarizeGraphMessage', () => {
  it('labels the WhatsApp Pay shapes for the inbox', () => {
    expect(
      summarizeGraphMessage({ type: 'interactive', interactive: { type: 'order_details', body: { text: 'Your order comes to ₹1,099' } } }),
    ).toBe('[WhatsApp Pay order card] Your order comes to ₹1,099')
    expect(
      summarizeGraphMessage({ type: 'interactive', interactive: { type: 'cta_url', body: { text: 'Prefer COD?' }, action: { parameters: { url: 'https://x.test/i' } } } }),
    ).toBe('Prefer COD? https://x.test/i')
    expect(summarizeGraphMessage({ type: 'text', text: { body: 'Hi' } })).toBe('Hi')
  })
})

describe('handleCatalogCart', () => {
  it('leaves the cart to the AI when the app is not configured', async () => {
    delete process.env.VANAMATI_APP_URL
    const handled = await handleCatalogCart({
      accountId: 'a',
      conversationId: 'c',
      contactId: 'k',
      phone: '919876543210',
      name: null,
      order: { product_items: [{ product_retailer_id: '1', quantity: 1 }] },
    })
    expect(handled).toBe(false)
  })
})
