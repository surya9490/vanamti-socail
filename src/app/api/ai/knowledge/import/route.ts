import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { crawlSite, CrawlError } from '@/lib/ai/crawl'
import { AiError } from '@/lib/ai/types'

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
    const rawMax = Number(body?.max_pages)
    const maxPages = Number.isFinite(rawMax)
      ? Math.min(30, Math.max(1, Math.floor(rawMax)))
      : undefined

    let pages
    try {
      pages = await crawlSite(url, { maxPages })
    } catch (err) {
      if (err instanceof CrawlError) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
      throw err
    }

    if (pages.length === 0) {
      return NextResponse.json(
        { error: 'No readable pages were found at that URL.' },
        { status: 400 },
      )
    }

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      supabase,
      accountId,
    )

    let imported = 0
    let updated = 0
    let failed = 0
    let indexFailed = 0

    for (const page of pages) {
      // Find-or-update on (account_id, source_url) — a plain upsert can't
      // reliably infer a *partial* unique index via PostgREST, so do it
      // explicitly.
      const { data: existing } = await supabase
        .from('ai_knowledge_documents')
        .select('id')
        .eq('account_id', accountId)
        .eq('source_url', page.url)
        .maybeSingle()

      let documentId: string
      if (existing?.id) {
        const { error: upErr } = await supabase
          .from('ai_knowledge_documents')
          .update({ title: page.title, content: page.text, source_type: 'website' })
          .eq('id', existing.id)
        if (upErr) {
          failed++
          continue
        }
        documentId = existing.id
        updated++
      } else {
        const { data: inserted, error: insErr } = await supabase
          .from('ai_knowledge_documents')
          .insert({
            account_id: accountId,
            created_by: userId,
            title: page.title,
            content: page.text,
            source_type: 'website',
            source_url: page.url,
          })
          .select('id')
          .single()
        if (insErr || !inserted) {
          failed++
          continue
        }
        documentId = inserted.id
        imported++
      }

      try {
        await ingestDocument(
          supabase,
          accountId,
          { embeddingsApiKey },
          documentId,
          page.text,
        )
      } catch (err) {
        // The document is saved; only its (optional) semantic index
        // failed. Lexical search still works — count it and move on.
        const message = err instanceof AiError ? err.message : 'indexing failed'
        console.error(`[ai/knowledge import] ingest failed for ${page.url}:`, message)
        indexFailed++
      }
    }

    return NextResponse.json({
      success: true,
      pages: pages.length,
      imported,
      updated,
      failed,
      indexFailed,
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
