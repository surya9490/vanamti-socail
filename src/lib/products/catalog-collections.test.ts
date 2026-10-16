import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchCatalogCollections, resetCatalogCollectionsCache } from './catalog-collections'

const ok = (collections: unknown) =>
  new Response(JSON.stringify({ ok: true, collections }), { status: 200 })

describe('fetchCatalogCollections', () => {
  beforeEach(() => {
    resetCatalogCollectionsCache()
    vi.stubEnv('VANAMATI_APP_URL', 'https://app.example/')
    vi.stubEnv('VANAMATI_ORDER_STATUS_KEY', 'k')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('reads the flagged collections with the shared key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ok([{ id: '3', title: ' Pure Desi Ghee ', handle: 'pure-desi-ghee', product_ids: ['a', 'b'] }, { id: 4 }]),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchCatalogCollections()).toEqual([
      { id: '3', title: 'Pure Desi Ghee', productIds: ['a', 'b'] },
    ])
    expect(fetchMock.mock.calls[0][0]).toBe('https://app.example/api/catalog-collections')
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'x-api-key': 'k' })
  })

  it('caches a good answer and reuses it when the app later fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok([{ id: '1', title: 'Honey', product_ids: [] }]))
    vi.stubGlobal('fetch', fetchMock)
    await fetchCatalogCollections()
    await fetchCatalogCollections()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 10 * 60_000)
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 502 }))
    expect(await fetchCatalogCollections()).toEqual([{ id: '1', title: 'Honey', productIds: [] }])
    vi.useRealTimers()
  })

  it('returns null when unconfigured or failing with nothing cached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))
    expect(await fetchCatalogCollections()).toBeNull()
    vi.stubEnv('VANAMATI_APP_URL', '')
    expect(await fetchCatalogCollections()).toBeNull()
  })
})
