import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasNewerCustomerText, type OwnInbound } from './supersede'

/** Fake `messages` table: honours the gte(created_at) filter only. */
function db(rows: OwnInbound[]): SupabaseClient {
  let since = ''
  const q = {
    select: () => q,
    eq: () => q,
    gte: (_col: string, v: string) => {
      since = v
      return q
    },
    limit: async () => ({
      data: rows.filter((r) => Date.parse(r.created_at) >= Date.parse(since)),
      error: null,
    }),
  }
  return { from: () => q } as unknown as SupabaseClient
}

// The 2026-11-19 burst: WhatsApp send times, whole seconds.
const ues1 = { id: 'a1', created_at: '2026-11-19T16:03:21+00:00' }
const ues2 = { id: 'b2', created_at: '2026-11-19T16:03:22+00:00' }
const yes = { id: 'c3', created_at: '2026-11-19T16:03:24+00:00' }

describe('hasNewerCustomerText', () => {
  it('a later-sent message supersedes even if this dispatch started after it was sent', async () => {
    // The "Ues" dispatch started at :24.58; "Yes" was sent at :24.00 and
    // arrived later. The old clock check missed it — message order doesn't.
    const fallback = '2026-11-19T16:03:24.584Z'
    expect(
      await hasNewerCustomerText(db([ues1, ues2, yes]), 'conv', ues2, fallback)
    ).toBe(true)
    expect(
      await hasNewerCustomerText(db([ues1, ues2, yes]), 'conv', ues1, fallback)
    ).toBe(true)
  })

  it('the last message of a burst is not superseded', async () => {
    expect(
      await hasNewerCustomerText(
        db([ues1, ues2, yes]),
        'conv',
        yes,
        '2026-11-19T16:03:27Z'
      )
    ).toBe(false)
  })

  it('same-second messages: exactly one survives', async () => {
    const x = { id: 'x1', created_at: '2026-11-19T16:03:30+00:00' }
    const y = { id: 'y2', created_at: '2026-11-19T16:03:30+00:00' }
    const rows = [x, y]
    const results = await Promise.all(
      [x, y].map((own) =>
        hasNewerCustomerText(db(rows), 'conv', own, own.created_at)
      )
    )
    expect(results.filter((superseded) => !superseded)).toHaveLength(1)
  })

  it('without its own row, falls back to "anything stamped after the dispatch started"', async () => {
    expect(
      await hasNewerCustomerText(
        db([ues1, ues2, yes]),
        'conv',
        null,
        '2026-11-19T16:03:23Z'
      )
    ).toBe(true)
    expect(
      await hasNewerCustomerText(
        db([ues1, ues2, yes]),
        'conv',
        null,
        '2026-11-19T16:03:25Z'
      )
    ).toBe(false)
  })
})
