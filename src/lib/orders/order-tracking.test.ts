import { describe, it, expect } from 'vitest'
import { extractOrderNumber } from './order-tracking'

// extractOrderNumber runs INSIDE the order_lookup automation step,
// after the merchant's Keyword Match trigger already filtered intent —
// so it is deliberately permissive about where the number appears.
describe('extractOrderNumber', () => {
  it('finds the number in common phrasings', () => {
    expect(extractOrderNumber('track 1024')).toBe('1024')
    expect(extractOrderNumber('Track my order 1024 please')).toBe('1024')
    expect(extractOrderNumber('order status 1024')).toBe('1024')
    expect(extractOrderNumber('where is my order #1024?')).toBe('1024')
    expect(extractOrderNumber('1024')).toBe('1024')
    expect(extractOrderNumber('#1024')).toBe('1024')
    expect(extractOrderNumber('# 1024')).toBe('1024')
  })

  it('prefers the #-prefixed number when both appear', () => {
    expect(extractOrderNumber('my 2nd order 555 is #1024')).toBe('1024')
  })

  it('requires 3-8 digits', () => {
    expect(extractOrderNumber('track 12')).toBeNull()
    expect(extractOrderNumber('track 123456789')).toBeNull()
    expect(extractOrderNumber('2')).toBeNull()
  })

  it('handles empty input', () => {
    expect(extractOrderNumber('')).toBeNull()
    expect(extractOrderNumber(null)).toBeNull()
    expect(extractOrderNumber(undefined)).toBeNull()
  })
})
