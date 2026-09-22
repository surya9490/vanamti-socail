import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { orderLookupTool, LOOKUP_DOWN_GUIDANCE } from './order-lookup'
import type { ToolContext } from './registry'
import {
  LOOKUP_UNAVAILABLE,
  orderTrackingConfigured,
  fetchOrderStatus,
  fetchRecentOrders,
} from '@/lib/orders/order-tracking'

// Keep the real extractOrderNumber + copy constants; stub only the
// side-effecting functions (env check + network calls).
vi.mock('@/lib/orders/order-tracking', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/orders/order-tracking')>()
  return {
    ...actual,
    orderTrackingConfigured: vi.fn(() => true),
    fetchOrderStatus: vi.fn(),
    fetchRecentOrders: vi.fn(),
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
  vi.mocked(fetchOrderStatus).mockReset()
  vi.mocked(fetchRecentOrders).mockReset()
  vi.mocked(fetchOrderStatus).mockResolvedValue({
    found: true,
    delayed: false,
    message: 'Order #1024 is out for delivery.',
  })
  vi.mocked(fetchRecentOrders).mockResolvedValue({
    found: true,
    delayed: false,
    message:
      "Here are your 2 recent orders:\n\n📦 Order #1024 (Aug 25) — Shipped\n✅ Order #1005 (Aug 20) — Delivered",
  })
})

describe('orderLookupTool', () => {
  it('looks up with the CONTACT phone (not a model-supplied one)', async () => {
    const result = await orderLookupTool.run({ order_number: '1024' }, ctx())
    expect(result).toContain('Order #1024 is out for delivery.')
    expect(result).toContain('Do not pitch products')
    expect(fetchOrderStatus).toHaveBeenCalledWith({
      orderNumber: '1024',
      senderPhone: '+15551234567',
    })
  })

  it('normalises a #-prefixed order number', async () => {
    await orderLookupTool.run({ order_number: '#SO-1024' }, ctx())
    expect(fetchOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'SO-1024' }),
    )
  })

  it('lists recent orders by phone when no order number was given', async () => {
    const result = await orderLookupTool.run({}, ctx())
    expect(result).toContain('recent orders')
    expect(fetchRecentOrders).toHaveBeenCalledWith({
      senderPhone: '+15551234567',
    })
    // The per-order lookup should NOT fire when we don't have a number.
    expect(fetchOrderStatus).not.toHaveBeenCalled()
  })

  it('degrades gracefully with no phone on file', async () => {
    const result = await orderLookupTool.run(
      { order_number: '1024' },
      ctx({ contactPhone: null }),
    )
    expect(result).toBe(LOOKUP_UNAVAILABLE)
    expect(fetchOrderStatus).not.toHaveBeenCalled()
  })

  it('degrades gracefully when order tracking is not configured', async () => {
    vi.mocked(orderTrackingConfigured).mockReturnValue(false)
    const result = await orderLookupTool.run({ order_number: '1024' }, ctx())
    expect(result).toBe(LOOKUP_UNAVAILABLE)
  })

  // Live 2026-09-22: "vana1073" (no '#') was read as "no order number",
  // fell through to a broken phone search, and the bot told the customer
  // the order didn't exist.
  it("passes 'vana1073' (no #) through as the order number", async () => {
    await orderLookupTool.run({ order_number: 'vana1073' }, ctx())
    expect(fetchOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'vana1073' }),
    )
  })

  it('a miss on a given number → instructions: never "no order", holding line + handoff', async () => {
    vi.mocked(fetchOrderStatus).mockResolvedValue({ found: false, delayed: false, message: 'no match' })
    const result = await orderLookupTool.run({ order_number: 'vana1073' }, ctx())
    expect(result).toMatch(/ORDER NOT MATCHED/)
    expect(result).toMatch(/NEVER say or imply "you have no order"/)
    expect(result).toMatch(/NEVER offer to place a new order/)
    expect(result).toContain('vana1073')
    expect(result).toContain('[[HANDOFF]]')
    expect(result).not.toContain('no match')
  })

  it('a miss with no number → holding line + handoff too (a person finds the order), never "no order"', async () => {
    vi.mocked(fetchRecentOrders).mockResolvedValue({ found: false, delayed: false, message: 'none' })
    const c = ctx()
    const result = await orderLookupTool.run({}, c)
    expect(result).toMatch(/ORDER NOT MATCHED/)
    expect(result).toContain('Please give me some time to check your order status')
    expect(result).toContain('[[HANDOFF]]')
    expect(c.signals?.orderLookup).toBe('missed')
  })

  it('records the outcome for the order guard', async () => {
    const c = ctx()
    await orderLookupTool.run({ order_number: '1024' }, c)
    expect(c.signals?.orderLookup).toBe('found')
    vi.mocked(fetchOrderStatus).mockResolvedValue(null)
    await orderLookupTool.run({ order_number: '1024' }, c)
    expect(c.signals?.orderLookup).toBe('down')
  })

  it('a delayed order → apologise, team is checking, hand off', async () => {
    vi.mocked(fetchRecentOrders).mockResolvedValue({
      found: true,
      delayed: true,
      message: 'Here is your recent order:\n\n⏳ Order #vana1049 (17 Sep) — Confirmed, dispatch delayed',
    })
    const result = await orderLookupTool.run({}, ctx())
    expect(result).toContain('#vana1049')
    expect(result).toMatch(/DELAYED ORDER/)
    expect(result).toContain('[[HANDOFF]]')
  })

  it('order system down → calm holding line + handoff, never "no order"', async () => {
    vi.mocked(fetchOrderStatus).mockResolvedValue(null)
    const result = await orderLookupTool.run({ order_number: '1024' }, ctx())
    expect(result).toBe(LOOKUP_DOWN_GUIDANCE)
  })
})
