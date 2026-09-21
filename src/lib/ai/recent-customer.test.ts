import { describe, it, expect } from 'vitest'
import { detectRecentCustomer, isTransactionalTemplate } from './recent-customer'

const NOW = Date.parse('2026-09-21T10:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 24 * 3_600_000).toISOString()
const tpl = (name: string, d: number) => ({ created_at: daysAgo(d), content_type: 'template', template_name: name, content_text: null })
const text = (body: string, d: number) => ({ created_at: daysAgo(d), content_type: 'text', template_name: null, content_text: body })

describe('isTransactionalTemplate', () => {
  it('recognises order / delivery / review templates', () => {
    for (const n of ['order_confirmation_v1', 'order_management_4', 'review_request_v2', 'review_request', 'shipping_update', 'delivery_status', 'order_dispatched'])
      expect(isTransactionalTemplate(n)).toBe(true)
  })
  it('does NOT count templates that go to people who have not bought', () => {
    for (const n of ['cart_recovery_v3', 'cart_recovery_v2', 'welcome_code', 'abandoned_cart_1', null, undefined, ''])
      expect(isTransactionalTemplate(n)).toBe(false)
  })
})

describe('detectRecentCustomer', () => {
  it('flags an order-confirmation template inside the window (the live case)', () => {
    const v = detectRecentCustomer([tpl('order_management_4', 2), text('May I know the status of this order', 0)], { now: NOW })
    expect(v).toEqual({ recent: true, signal: 'transactional_template', at: daysAgo(2) })
  })

  it('flags an order number typed by either side even when no template was sent', () => {
    expect(detectRecentCustomer([text('#vana1061', 0.1)], { now: NOW }).signal).toBe('order_number')
    expect(detectRecentCustomer([text('Order #vana1061 is confirmed and being packed', 0.1)], { now: NOW }).signal).toBe('order_number')
    expect(detectRecentCustomer([text('Order vana1061 is confirmed', 0.1)], { now: NOW }).signal).toBe('order_number')
  })

  it('ignores signals older than the window', () => {
    expect(detectRecentCustomer([tpl('order_management_4', 11)], { now: NOW }).recent).toBe(false)
    expect(detectRecentCustomer([tpl('order_management_4', 11)], { now: NOW, windowDays: 30 }).recent).toBe(true)
  })

  it('ignores cart-recovery and welcome templates, and plain chat', () => {
    const v = detectRecentCustomer([tpl('cart_recovery_v3', 1), tpl('welcome_code', 1), text('Hi, what do you sell?', 0)], { now: NOW })
    expect(v).toEqual({ recent: false, signal: null, at: null })
  })

  it('reports the most recent signal', () => {
    const v = detectRecentCustomer([tpl('order_management_4', 8), tpl('review_request_v2', 3)], { now: NOW })
    expect(v.at).toBe(daysAgo(3))
  })

  it('does not trip on the word "order" in ordinary text', () => {
    expect(detectRecentCustomer([text('Can I order 2 jars?', 0)], { now: NOW }).recent).toBe(false)
  })
})
