import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolContext } from './registry'
import { resolveLineItem } from './create-draft-order'

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
