import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolContext } from './registry'
import { createDraftOrderTool, resetDraftOrderDedupe, resolveLineItem } from './create-draft-order'

const iyappa = {
  shop_product_id: '8774974505095',
  title: 'Iyappa Cow Ghee',
  is_active: true,
  variants: [
    { id: 'v250', title: '250ml', is_available: false },
    { id: 'v500', title: '500ml', is_available: true },
    { id: 'v1000', title: '1000ml' }, // cached before the flag existed → in stock
  ],
}

function ctx(): ToolContext {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: iyappa, error: null }),
  }
  return {
    db: { from: () => query } as unknown as SupabaseClient,
    accountId: 'acct-1',
    conversationId: 'conv-1',
    contactId: 'contact-1',
    contactPhone: '+15551234567',
  }
}

describe('create_draft_order resolveLineItem', () => {
  it('refuses a sold-out size, by id or by title', async () => {
    for (const args of [
      { shop_product_id: '8774974505095', variant_id: 'v250' },
      { shop_product_id: '8774974505095', variant_title: '250 ml' },
    ]) {
      const r = await resolveLineItem(args, ctx())
      expect(r).toEqual(expect.stringContaining('Iyappa Cow Ghee 250ml is SOLD OUT'))
    }
  })

  it('resolves an in-stock size', async () => {
    expect(await resolveLineItem({ shop_product_id: '8774974505095', variant_id: 'v500', quantity: 2 }, ctx())).toEqual({
      variant_id: 'v500',
      quantity: 2,
    })
    expect(await resolveLineItem({ shop_product_id: '8774974505095', variant_title: '1L' }, ctx())).toEqual({
      variant_id: 'v1000',
      quantity: 1,
    })
  })
})

describe('create_draft_order — one purchase, one payment link', () => {
  // The 2026-11-19 burst: three dispatches for one "yes", same order.
  const order = {
    shop_product_id: '8774974505095',
    variant_id: 'v500',
    quantity: 1,
    customer_name: 'FAROOKKHAN',
    address_line1: 'No.91, 3rd East Cross Street, Gokul Nagar Phase-1',
    address_line2: 'Near Jairam Public School',
    city: 'Salem',
    state: 'Tamil Nadu',
    pincode: '636008',
  }
  let created = 0
  const fetchMock = vi.fn(async () => {
    created += 1
    await new Promise((r) => setTimeout(r, 5)) // in flight while the others arrive
    return new Response(JSON.stringify({ invoice_url: `https://shop.test/invoices/${created}` }), { status: 200 })
  })

  beforeEach(() => {
    created = 0
    fetchMock.mockClear()
    resetDraftOrderDedupe()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('VANAMATI_APP_URL', 'https://app.test')
    vi.stubEnv('VANAMATI_ORDER_STATUS_KEY', 'k')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('concurrent calls for the same order create ONE draft and share its link', async () => {
    const results = await Promise.all([
      createDraftOrderTool.run(order, ctx()),
      createDraftOrderTool.run({ ...order, address_line1: 'No.91 3rd East Cross Street  Gokul Nagar Phase-1' }, ctx()),
      createDraftOrderTool.run(order, ctx()),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (const r of results) expect(r).toContain('https://shop.test/invoices/1')
  })

  it('a repeat a few minutes later gets the same link', async () => {
    const first = await createDraftOrderTool.run(order, ctx())
    const again = await createDraftOrderTool.run(order, ctx())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(again).toBe(first)
  })

  it('a changed address or size is a new purchase', async () => {
    await createDraftOrderTool.run(order, ctx())
    await createDraftOrderTool.run({ ...order, pincode: '636010' }, ctx())
    await createDraftOrderTool.run({ ...order, variant_id: 'v1000' }, ctx())
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a failed create is not cached — the retry tries again', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('boom', { status: 502 }))
    const failed = await createDraftOrderTool.run(order, ctx())
    expect(failed).toContain('temporarily unavailable')
    const retry = await createDraftOrderTool.run(order, ctx())
    expect(retry).toContain('Draft order created')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
