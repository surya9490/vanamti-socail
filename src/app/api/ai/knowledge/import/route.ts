import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { CrawlError } from '@/lib/ai/crawl'
import {
  importSiteIntoKnowledge,
  clampMaxPages,
} from '@/lib/ai/knowledge-import'

/**
 * POST /api/ai/knowledge/import  (admin+)
 *
 * Crawl a website and load each page into the knowledge base. The whole
 * crawl + ingest runs server-side under one request (one rate-limit
 * token), not by looping the per-doc POST route — so a multi-page import
 * doesn't burn through the admin-action limit.
 *
 * Idempotent: a doc is keyed by (account_id, source_url), so re-importing
 * updates the existing document for each page instead of duplicating it.
 * The same logic runs weekly from /api/cron/knowledge-recrawl.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-import:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const url = typeof body?.url === 'string' ? body.url.trim() : ''
    if (!url) {
      return NextResponse.json({ error: 'url is required' }, { status: 400 })
    }

    let result
    try {
      result = await importSiteIntoKnowledge(supabase, {
        accountId,
        userId,
        url,
        maxPages: clampMaxPages(body?.max_pages),
      })
    } catch (err) {
      if (err instanceof CrawlError) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
      throw err
    }

    if (result.pages === 0) {
      return NextResponse.json(
        { error: 'No readable pages were found at that URL.' },
        { status: 400 },
      )
    }

    const { corrupt, ...counts } = result
    return NextResponse.json({
      success: true,
      ...counts,
      ...(corrupt
        ? {
            warning:
              'Imported with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
          }
        : {}),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
