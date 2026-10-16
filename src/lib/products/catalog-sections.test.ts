import { describe, expect, it } from 'vitest'
import { groupCatalogSections } from './catalog-sections'

const product = (title: string, type: string | null, variantIds: Array<[string, number]>) => ({
  shop_product_id: `p-${title}`,
  title,
  product_type: type,
  image_url: null,
  price_min: null,
  variants: variantIds.map(([id, price]) => ({
    id,
    title: null,
    price,
    sku: null,
    is_available: true,
  })),
})

describe('groupCatalogSections', () => {
  it('groups by product type, biggest category first, cheapest variant per product', () => {
    const { sections, retailerIds, meta } = groupCatalogSections([
      product('A2 Cow Ghee', 'Ghee', [['g1-500', 1099], ['g1-250', 599]]),
      product('Acacia Honey', 'Honey', [['h1-250', 399]]),
      product('Forest Honey', 'Honey', [['h2-250', 549]]),
      product('Iyappa Ghee', 'Ghee', [['g2-250', 349]]),
      product('Wild Forest Honey', 'Honey', [['h3-250', 289]]),
    ])
    expect(sections).toEqual([
      { title: 'Honey', productRetailerIds: ['h1-250', 'h2-250', 'h3-250'] },
      { title: 'Ghee', productRetailerIds: ['g1-250', 'g2-250'] },
    ])
    expect(retailerIds).toHaveLength(5)
    expect(meta['g1-250']).toMatchObject({ title: 'A2 Cow Ghee', price: 599 })
  })

  it('sends every product, not just the first 8 by title', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      product(`Honey ${String(i).padStart(2, '0')}`, 'Honey', [[`v${i}`, 100]]),
    )
    expect(groupCatalogSections(rows).retailerIds).toHaveLength(12)
  })

  it('puts untyped products in a trailing "More products" section', () => {
    const { sections } = groupCatalogSections([
      product('Gift Box', null, [['x1', 999]]),
      product('Acacia Honey', 'Honey', [['h1', 399]]),
    ])
    expect(sections.map((s) => s.title)).toEqual(['Honey', 'More products'])
  })

  it('caps at 30 products and 10 sections, and skips products without variants', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      product(`P${String(i).padStart(2, '0')}`, `Type ${i % 12}`, [[`v${i}`, 100]]),
    )
    many.push(product('No Variants', 'Honey', []))
    const { sections, retailerIds, meta } = groupCatalogSections(many)
    expect(retailerIds).toHaveLength(30)
    expect(sections.length).toBeLessThanOrEqual(10)
    expect(Object.keys(meta)).toHaveLength(30)
    expect(retailerIds).not.toContain(undefined)
  })

  it('applies the retailer id prefix and truncates long section titles to 24 chars', () => {
    const { sections } = groupCatalogSections(
      [product('Oil', 'Cold Pressed Wood-Churned Oils', [['o1', 200]])],
      30,
      'shopify_IN_',
    )
    expect(sections[0].title).toHaveLength(24)
    expect(sections[0].productRetailerIds).toEqual(['shopify_IN_o1'])
  })
})
