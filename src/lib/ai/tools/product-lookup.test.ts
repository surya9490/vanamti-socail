import { describe, expect, it } from 'vitest'
import { formatRow } from './product-lookup'

const row = (variants: Array<{ id: string; title: string; price: number; is_available?: boolean }>) => ({
  title: 'Iyappa Cow Ghee',
  shop_product_id: '8774974505095',
  price_min: 349,
  price_max: 1199,
  currency: 'INR',
  product_url: 'https://example.com/products/iyappa-ghee',
  variants: variants.map((v) => ({ sku: null, ...v })),
})

describe('product_lookup formatRow', () => {
  it('lists in-stock sizes with their variant ids and the link', () => {
    const out = formatRow(
      row([
        { id: 'v250', title: '250ml', price: 349, is_available: true },
        { id: 'v500', title: '500ml', price: 649 }, // cached before the flag existed → in stock
      ]),
    )
    expect(out).toContain('[product_id: 8774974505095]')
    expect(out).toContain('https://example.com/products/iyappa-ghee')
    expect(out).toContain('250ml — ₹349 [variant_id: v250]')
    expect(out).toContain('500ml — ₹649 [variant_id: v500]')
    expect(out).not.toContain('SOLD OUT')
  })

  it('marks a sold-out size and gives it no variant id', () => {
    const out = formatRow(
      row([
        { id: 'v250', title: '250ml', price: 349, is_available: true },
        { id: 'v500', title: '500ml', price: 649, is_available: false },
      ]),
    )
    expect(out).toContain('250ml — ₹349 [variant_id: v250]')
    expect(out).toContain('500ml — ₹649 — SOLD OUT')
    expect(out).not.toContain('v500')
  })

  it('gives no ids or link when every size is sold out', () => {
    const out = formatRow(
      row([
        { id: 'v250', title: '250ml', price: 349, is_available: false },
        { id: 'v1000', title: '1000ml', price: 1199, is_available: false },
      ]),
    )
    expect(out).toContain('Iyappa Cow Ghee — ₹349–₹1199 — SOLD OUT (every size)')
    expect(out).toContain('do NOT share the link')
    expect(out).not.toMatch(/product_id|variant_id|https:/)
  })
})
