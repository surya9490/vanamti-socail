import { describe, expect, it } from 'vitest'
import { groupByCollections, groupCatalogSections } from './catalog-sections'

const product = (title: string, type: string | null, variantIds: Array<[string, number]>, id = `p-${title}`) => ({
  shop_product_id: id,
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

describe('groupByCollections', () => {
  // Mirrors the live store: All (every product), Pure Natural Honey, Pure Desi Ghee.
  const rows = [
    product('A2 Cow Ghee', 'Ghee', [['g1-250', 599]], 'a2'),
    product('Acacia Honey', 'Honey', [['h1-250', 399]], 'acacia'),
    product('Forest Honey', 'Honey', [['h2-250', 549]], 'forest'),
    product('Iyappa Ghee', 'Ghee', [['g2-250', 349]], 'iyappa'),
    product('Wild Forest Honey', 'Honey', [['h3-250', 289]], 'wild'),
  ]
  const all = { id: '1', title: 'All', productIds: ['iyappa', 'a2', 'forest', 'acacia', 'wild'] }
  const honey = { id: '2', title: 'Pure Natural Honey', productIds: ['forest', 'acacia', 'wild'] }
  const ghee = { id: '3', title: 'Pure Desi Ghee', productIds: ['iyappa', 'a2'] }

  it('one section per flagged collection, biggest first, in collection order; "All" skipped', () => {
    const c = groupByCollections(rows, [all, ghee, honey])!
    expect(c.sections).toEqual([
      { title: 'Pure Natural Honey', productRetailerIds: ['h2-250', 'h1-250', 'h3-250'] },
      { title: 'Pure Desi Ghee', productRetailerIds: ['g2-250', 'g1-250'] },
    ])
    expect(Object.keys(c.meta)).toHaveLength(5)
  })

  it('a product in two collections appears once, under the first', () => {
    const bestSellers = { id: '4', title: 'Best Sellers', productIds: ['forest', 'iyappa'] }
    const c = groupByCollections(rows, [honey, ghee, bestSellers])!
    expect(c.retailerIds).toHaveLength(5)
    expect(new Set(c.retailerIds).size).toBe(5)
    // Best Sellers ties Pure Desi Ghee on size and sorts first, so it keeps Iyappa.
    expect(c.sections).toEqual([
      { title: 'Pure Natural Honey', productRetailerIds: ['h2-250', 'h1-250', 'h3-250'] },
      { title: 'Best Sellers', productRetailerIds: ['g2-250'] },
      { title: 'Pure Desi Ghee', productRetailerIds: ['g1-250'] },
    ])
  })

  it('products in no flagged collection go under "More products"; unknown or inactive ids are ignored', () => {
    const c = groupByCollections(rows, [{ ...honey, productIds: [...honey.productIds, 'draft-product'] }])!
    expect(c.sections).toEqual([
      { title: 'Pure Natural Honey', productRetailerIds: ['h2-250', 'h1-250', 'h3-250'] },
      { title: 'More products', productRetailerIds: ['g1-250', 'g2-250'] },
    ])
  })

  it('returns null when no collection gives a usable section, so the caller falls back to type', () => {
    expect(groupByCollections(rows, [all])).toBeNull()
    expect(groupByCollections(rows, [{ id: '9', title: 'Oils', productIds: [] }])).toBeNull()
    expect(groupByCollections(rows, [])).toBeNull()
  })
})
