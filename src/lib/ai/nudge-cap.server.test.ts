import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchNudgeBudget, MAX_NUDGES_PER_DAY } from './nudge-cap.server'

const NOW = Date.parse('2026-10-17T10:00:00Z')

interface TableResult {
  data?: unknown
  count?: number | null
  error?: { message: string } | null
}

/** Chainable stub: every filter returns the builder, awaiting it yields
 *  the table's canned result. Records the gte cutoff per table. */
function stubDb(results: Record<string, TableResult>) {
  const since: Record<string, unknown> = {}
  const db = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        gte(_col: string, value: unknown) {
          since[table] = value
          return builder
        },
        then(onFulfilled: (v: TableResult) => unknown) {
          const r = results[table] ?? {}
          return Promise.resolve({ data: r.data ?? null, count: r.count ?? null, error: r.error ?? null }).then(
            onFulfilled,
          )
        },
      }
      return builder
    },
  }
  return { db: db as unknown as SupabaseClient, since }
}

describe('fetchNudgeBudget', () => {
  it('caps at 2 follow-ups a day', () => {
    expect(MAX_NUDGES_PER_DAY).toBe(2)
  })

  it('adds close-nudges and re-engagement sends together', async () => {
    const { db } = stubDb({
      conversations: { data: [{ id: 'conv-1' }] },
      conversation_close_nudges: { count: 1 },
      contact_re_engagement_sends: { count: 1 },
    })
    expect(await fetchNudgeBudget(db, 'contact-1', NOW)).toEqual({ sent: 2, capReached: true })
  })

  it('leaves room under the cap', async () => {
    const { db } = stubDb({
      conversations: { data: [{ id: 'conv-1' }] },
      conversation_close_nudges: { count: 1 },
      contact_re_engagement_sends: { count: 0 },
    })
    expect(await fetchNudgeBudget(db, 'contact-1', NOW)).toEqual({ sent: 1, capReached: false })
  })

  it('counts only the last 24 hours', async () => {
    const { db, since } = stubDb({
      conversations: { data: [{ id: 'conv-1' }] },
      conversation_close_nudges: { count: 0 },
      contact_re_engagement_sends: { count: 0 },
    })
    await fetchNudgeBudget(db, 'contact-1', NOW)
    const cutoff = new Date(NOW - 24 * 3_600_000).toISOString()
    expect(since.conversation_close_nudges).toBe(cutoff)
    expect(since.contact_re_engagement_sends).toBe(cutoff)
  })

  it('still counts re-engagement sends for a contact with no conversations', async () => {
    const { db } = stubDb({
      conversations: { data: [] },
      contact_re_engagement_sends: { count: 2 },
    })
    expect(await fetchNudgeBudget(db, 'contact-1', NOW)).toEqual({ sent: 2, capReached: true })
  })

  it('treats a failed lookup as at the cap', async () => {
    const failedConvs = stubDb({ conversations: { error: { message: 'boom' } } })
    expect(await fetchNudgeBudget(failedConvs.db, 'contact-1', NOW)).toEqual({ sent: null, capReached: true })

    const failedLedger = stubDb({
      conversations: { data: [{ id: 'conv-1' }] },
      conversation_close_nudges: { error: { message: 'boom' } },
      contact_re_engagement_sends: { count: 0 },
    })
    expect(await fetchNudgeBudget(failedLedger.db, 'contact-1', NOW)).toEqual({ sent: null, capReached: true })
  })
})
