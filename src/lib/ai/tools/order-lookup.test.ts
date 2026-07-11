import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { orderLookupTool } from './order-lookup'
import type { ToolContext } from './registry'
import {
  ASK_FOR_ORDER_NUMBER,
  LOOKUP_UNAVAILABLE,
  orderTrackingConfigured,
  fetchOrderStatusReply,
} from '@/lib/orders/order-tracking'

// Keep the real extractOrderNumber + copy constants; stub only the two
// side-effecting functions (env check + network call).
vi.mock('@/lib/orders/order-tracking', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/orders/order-tracking')>()
  return {
    ...actual,
    orderTrackingConfigured: vi.fn(() => true),
    fetchOrderStatusReply: vi.fn(async () => 'Order #1024 is out for delivery.'),
  }
})

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db: {} as SupabaseClient,
    accountId: 'acct-1',
    conversationId: 'conv-1',
    contactId: 'contact-1',
    contactPhone: '+15551234567',
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(orderTrackingConfigured).mockReturnValue(true)
  vi.mocked(fetchOrderStatusReply).mockResolvedValue(
    'Order #1024 is out for delivery.',
  )
})

describe('orderLookupTool', () => {
  it('looks up with the CONTACT phone (not a model-supplied one)', async () => {
    const result = await orderLookupTool.run({ order_number: '1024' }, ctx())
    expect(result).toBe('Order #1024 is out for delivery.')
    expect(fetchOrderStatusReply).toHaveBeenCalledWith({
      orderNumber: '1024',
      senderPhone: '+15551234567',
    })
  })

  it('normalises a #-prefixed order number', async () => {
    await orderLookupTool.run({ order_number: '#SO-1024' }, ctx())
    expect(fetchOrderStatusReply).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'SO-1024' }),
    )
  })

  it('asks for the number when none was given', async () => {
    const result = await orderLookupTool.run({}, ctx())
    expect(result).toBe(ASK_FOR_ORDER_NUMBER)
    expect(fetchOrderStatusReply).not.toHaveBeenCalled()
  })

  it('degrades gracefully with no phone on file', async () => {
    const result = await orderLookupTool.run(
      { order_number: '1024' },
      ctx({ contactPhone: null }),
    )
    expect(result).toBe(LOOKUP_UNAVAILABLE)
    expect(fetchOrderStatusReply).not.toHaveBeenCalled()
  })

  it('degrades gracefully when order tracking is not configured', async () => {
    vi.mocked(orderTrackingConfigured).mockReturnValue(false)
    const result = await orderLookupTool.run({ order_number: '1024' }, ctx())
    expect(result).toBe(LOOKUP_UNAVAILABLE)
  })
})
