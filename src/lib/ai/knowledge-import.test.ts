import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  crawlSite: vi.fn(),
  loadEmbeddingsKey: vi.fn(),
  ingestDocument: vi.fn(),
}))

vi.mock('./crawl', () => ({
  crawlSite: h.crawlSite,
  CrawlError: class CrawlError extends Error {},
}))
vi.mock('./config', () => ({ loadEmbeddingsKey: h.loadEmbeddingsKey }))
vi.mock('./knowledge', () => ({ ingestDocument: h.ingestDocument }))

import { importSiteIntoKnowledge, clampMaxPages } from './knowledge-import'

/**
 * Fake DB: `existingByUrl` decides whether a page is found (→ update)
 * or not (→ insert). Records every update/insert so tests can assert
 * the idempotent find-or-update behaviour.
 */
function fakeDb(existingByUrl: Record<string, string>) {
  const updates: Array<{ id: string; title: string }> = []
  const inserts: Array<{ source_url: string; created_by: string }> = []
  let lastUrl = ''
  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    from: () => chain,
    select: () => chain,
    eq: (col: string, val: string) => {
      if (col === 'source_url') lastUrl = val
      return chain
    },
    maybeSingle: () =>
      Promise.resolve({
        data: existingByUrl[lastUrl] ? { id: existingByUrl[lastUrl] } : null,
        error: null,
      }),
    update: (patch: { title: string }) => ({
      eq: (_c: string, id: string) => {
        updates.push({ id, title: patch.title })
        return Promise.resolve({ error: null })
      },
    }),
    insert: (row: { source_url: string; created_by: string }) => {
      inserts.push(row)
      return {
        select: () => ({
          single: () =>
            Promise.resolve({ data: { id: `new-${inserts.length}` }, error: null }),
        }),
      }
    },
  })
  return { db: chain as unknown as SupabaseClient, updates, inserts }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.loadEmbeddingsKey.mockResolvedValue({ key: null, corrupt: false })
  h.ingestDocument.mockResolvedValue(undefined)
})

describe('importSiteIntoKnowledge', () => {
  it('updates pages that already exist and inserts new ones (idempotent on source_url)', async () => {
    h.crawlSite.mockResolvedValue([
      { url: 'https://x.com/', title: 'Home', text: 'home text' },
      { url: 'https://x.com/about', title: 'About', text: 'about text' },
    ])
    const { db, updates, inserts } = fakeDb({ 'https://x.com/': 'doc-home' })

    const r = await importSiteIntoKnowledge(db, {
      accountId: 'acct',
      userId: 'owner',
      url: 'https://x.com',
    })

    expect(r).toMatchObject({ pages: 2, updated: 1, imported: 1, failed: 0, indexFailed: 0 })
    expect(updates).toEqual([{ id: 'doc-home', title: 'Home' }])
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({ source_url: 'https://x.com/about', created_by: 'owner' })
    // Every saved page gets (re)indexed.
    expect(h.ingestDocument).toHaveBeenCalledTimes(2)
  })

  it('returns zero counts and skips the embeddings key when the crawl finds nothing', async () => {
    h.crawlSite.mockResolvedValue([])
    const { db } = fakeDb({})
    const r = await importSiteIntoKnowledge(db, { accountId: 'a', userId: 'u', url: 'https://x.com' })
    expect(r).toEqual({ pages: 0, imported: 0, updated: 0, failed: 0, indexFailed: 0, corrupt: false })
    expect(h.loadEmbeddingsKey).not.toHaveBeenCalled()
  })

  it('counts an indexing failure without losing the saved document', async () => {
    h.crawlSite.mockResolvedValue([{ url: 'https://x.com/p', title: 'P', text: 't' }])
    h.ingestDocument.mockRejectedValueOnce(new Error('embed down'))
    const { db, inserts } = fakeDb({})
    const r = await importSiteIntoKnowledge(db, { accountId: 'a', userId: 'u', url: 'https://x.com' })
    expect(inserts).toHaveLength(1) // doc was still written
    expect(r).toMatchObject({ imported: 1, indexFailed: 1, failed: 0 })
  })

  it('surfaces a corrupt embeddings key as a flag, not a failure', async () => {
    h.crawlSite.mockResolvedValue([{ url: 'https://x.com/p', title: 'P', text: 't' }])
    h.loadEmbeddingsKey.mockResolvedValue({ key: null, corrupt: true })
    const { db } = fakeDb({})
    const r = await importSiteIntoKnowledge(db, { accountId: 'a', userId: 'u', url: 'https://x.com' })
    expect(r.corrupt).toBe(true)
    expect(r.imported).toBe(1)
  })
})

describe('clampMaxPages', () => {
  it('clamps into [1, 30] and returns undefined for non-numbers', () => {
    expect(clampMaxPages(500)).toBe(30)
    expect(clampMaxPages(0)).toBe(1)
    expect(clampMaxPages(12.9)).toBe(12)
    expect(clampMaxPages('abc')).toBeUndefined()
    expect(clampMaxPages(undefined)).toBeUndefined()
  })
})
