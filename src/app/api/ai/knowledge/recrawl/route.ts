import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { recrawlAccountWebsites } from '@/lib/ai/knowledge-import'

/**
 * POST /api/ai/knowledge/recrawl  (admin+)
 *
 * On-demand version of the weekly knowledge-recrawl cron, scoped to
 * the caller's account: re-import every website this account has
 * already imported, from each site's origin, without re-entering a
 * URL. The operator uses this right after editing site copy so the
 * bot picks it up immediately instead of on Monday.
 *
 * Same rate-limit bucket as the manual import (one crawl = one admin
 * action). Never deletes documents.
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-import:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const result = await recrawlAccountWebsites(supabase, { accountId, userId })

    if (result.targets === 0) {
      return NextResponse.json(
        { error: 'No website has been imported yet — use "Import from website" first.' },
        { status: 400 },
      )
    }

    const totals = result.results.reduce(
      (acc, r) => {
        if ('error' in r) {
          acc.errors++
        } else {
          acc.pages += r.pages
          acc.updated += r.updated
          acc.imported += r.imported
          acc.failed += r.failed
          acc.indexFailed += r.indexFailed
        }
        return acc
      },
      { pages: 0, updated: 0, imported: 0, failed: 0, indexFailed: 0, errors: 0 },
    )

    return NextResponse.json({ success: true, targets: result.targets, ...totals, results: result.results })
  } catch (err) {
    return toErrorResponse(err)
  }
}
