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

  it('accepts 3-12 digit numbers, rejects shorter/longer', () => {
    expect(extractOrderNumber('track 12')).toBeNull()
    // 9-digit orders are common in Shopify — previous 3-8 cap missed them.
    expect(extractOrderNumber('track 123456789')).toBe('123456789')
    // 12 digits still accepted, 13 rejected.
    expect(extractOrderNumber('track 123456789012')).toBe('123456789012')
    expect(extractOrderNumber('track 1234567890123')).toBeNull()
    expect(extractOrderNumber('2')).toBeNull()
  })

  it('accepts alphanumeric #-prefixed order names', () => {
    // Shopify order names are user-configurable; SO-/INV- prefixes are common.
    expect(extractOrderNumber('track #SO-1024')).toBe('SO-1024')
    expect(extractOrderNumber('where is #INV-2025-01')).toBe('INV-2025-01')
    expect(extractOrderNumber('order #ABC123')).toBe('ABC123')
  })

  it('handles empty input', () => {
    expect(extractOrderNumber('')).toBeNull()
    expect(extractOrderNumber(null)).toBeNull()
    expect(extractOrderNumber(undefined)).toBeNull()
  })
})
