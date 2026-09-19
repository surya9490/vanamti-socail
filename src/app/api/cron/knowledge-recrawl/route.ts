import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  recrawlAccountWebsites,
  KNOWLEDGE_IMPORT_MAX_PAGES,
} from '@/lib/ai/knowledge-import'

// ============================================================
// GET /api/cron/knowledge-recrawl
//
// Weekly re-crawl of every website an account has imported into its
// knowledge base, so the KB tracks site edits (prices, offers, policy
// copy, new products) without an operator re-clicking "Import from
// website". Before this the import was one-shot: the bot kept quoting
// whatever the site said on the day it was first imported.
//
// How the crawl root is found: the import stores one doc per page with
// its `source_url`. We group an account's website docs by URL origin
// (scheme + host) and re-crawl each origin from its homepage with the
// same same-origin, max-pages rules the manual import uses. Pages that
// disappeared are left in place — never delete knowledge on a crawl.
//
// Auth: x-cron-secret matches AUTOMATION_CRON_SECRET.
// Env:  KNOWLEDGE_RECRAWL_MAX_PAGES  default 30 (hard cap 30)
// Cadence: weekly (Railway cron `0 3 * * 1` = Monday 03:00 UTC).
// ============================================================

function verifyCronSecret(request: Request): boolean {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return false
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function maxPagesFromEnv(): number {
  const raw = Number(process.env.KNOWLEDGE_RECRAWL_MAX_PAGES)
  if (!Number.isFinite(raw) || raw <= 0) return KNOWLEDGE_IMPORT_MAX_PAGES
  return Math.min(KNOWLEDGE_IMPORT_MAX_PAGES, Math.floor(raw))
}

export async function GET(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const maxPages = maxPagesFromEnv()

  // Every account that has imported at least one website.
  const { data: rows, error: docsErr } = await db
    .from('ai_knowledge_documents')
    .select('account_id')
    .eq('source_type', 'website')
    .not('source_url', 'is', null)
  if (docsErr) {
    console.error('[knowledge-recrawl] docs query failed:', docsErr)
    return NextResponse.json({ error: docsErr.message }, { status: 500 })
  }
  const accountIds = [
    ...new Set(((rows ?? []) as { account_id: string }[]).map((r) => r.account_id)),
  ]

  const results: Array<Record<string, unknown>> = []
  for (const accountId of accountIds) {
    // created_by on any NEW page: the account owner (same fallback the
    // lead-tag mirror uses when no acting user exists).
    const { data: acct } = await db
      .from('accounts')
      .select('owner_user_id')
      .eq('id', accountId)
      .maybeSingle()
    const ownerUserId = (acct as { owner_user_id?: string } | null)?.owner_user_id
    if (!ownerUserId) {
      results.push({ account_id: accountId, skipped: 'no owner_user_id' })
      continue
    }

    try {
      const r = await recrawlAccountWebsites(db, {
        accountId,
        userId: ownerUserId,
        maxPages,
      })
      for (const t of r.results) {
        if ('error' in t) {
          console.warn(`[knowledge-recrawl] ${t.origin} account=${accountId} failed:`, t.error)
        } else {
          console.log(
            `[knowledge-recrawl] ${t.origin} account=${accountId} pages=${t.pages} updated=${t.updated} imported=${t.imported} failed=${t.failed} indexFailed=${t.indexFailed}`,
          )
        }
      }
      results.push({ account_id: accountId, ...r })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[knowledge-recrawl] account=${accountId} failed:`, message)
      results.push({ account_id: accountId, error: message })
    }
  }

  return NextResponse.json({
    accounts: accountIds.length,
    max_pages: maxPages,
    results,
  })
}
