import type { SupabaseClient } from '@supabase/supabase-js'
import { loadEmbeddingsKey } from './config'
import { ingestDocument } from './knowledge'
import { crawlSite } from './crawl'
import { AiError } from './types'

// ============================================================
// Shared "crawl a site → upsert each page into the knowledge base".
//
// Two callers:
//   * POST /api/ai/knowledge/import — operator clicks "Import from
//     website" in /agents → Setup → Knowledge (session-scoped client).
//   * GET  /api/cron/knowledge-recrawl — weekly re-run per account so
//     the KB tracks site edits without anyone re-clicking (service-
//     role client).
//
// Idempotent on (account_id, source_url): an existing page is updated
// in place, a new one is inserted. Pages that vanished from the site
// are left alone — a partial or failed crawl must never delete
// knowledge. CrawlError propagates so the HTTP route can map it to a
// 400; everything per-page is counted, not thrown.
// ============================================================

export const KNOWLEDGE_IMPORT_MAX_PAGES = 30

export interface ImportSiteArgs {
  accountId: string
  /** Audit column on inserted docs (`created_by`). For the cron this is
   *  the account owner; for the route it's the acting admin. */
  userId: string
  url: string
  maxPages?: number
}

export interface ImportSiteResult {
  pages: number
  imported: number
  updated: number
  failed: number
  indexFailed: number
  /** Embeddings key present but undecryptable — docs saved, lexical
   *  search only. Surfaced as a warning by the route. */
  corrupt: boolean
}

export function clampMaxPages(raw: unknown): number | undefined {
  const n = Number(raw)
  return Number.isFinite(n)
    ? Math.min(KNOWLEDGE_IMPORT_MAX_PAGES, Math.max(1, Math.floor(n)))
    : undefined
}

export async function importSiteIntoKnowledge(
  db: SupabaseClient,
  args: ImportSiteArgs,
): Promise<ImportSiteResult> {
  const pages = await crawlSite(args.url, { maxPages: args.maxPages })
  const result: ImportSiteResult = {
    pages: pages.length,
    imported: 0,
    updated: 0,
    failed: 0,
    indexFailed: 0,
    corrupt: false,
  }
  if (pages.length === 0) return result

  const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
    db,
    args.accountId,
  )
  result.corrupt = corrupt

  for (const page of pages) {
    // Find-or-update on (account_id, source_url) — a plain upsert can't
    // reliably infer a *partial* unique index via PostgREST, so do it
    // explicitly.
    const { data: existing } = await db
      .from('ai_knowledge_documents')
      .select('id')
      .eq('account_id', args.accountId)
      .eq('source_url', page.url)
      .maybeSingle()

    let documentId: string
    if (existing?.id) {
      const { error: upErr } = await db
        .from('ai_knowledge_documents')
        .update({ title: page.title, content: page.text, source_type: 'website' })
        .eq('id', existing.id)
      if (upErr) {
        result.failed++
        continue
      }
      documentId = existing.id
      result.updated++
    } else {
      const { data: inserted, error: insErr } = await db
        .from('ai_knowledge_documents')
        .insert({
          account_id: args.accountId,
          created_by: args.userId,
          title: page.title,
          content: page.text,
          source_type: 'website',
          source_url: page.url,
        })
        .select('id')
        .single()
      if (insErr || !inserted) {
        result.failed++
        continue
      }
      documentId = inserted.id
      result.imported++
    }

    try {
      await ingestDocument(
        db,
        args.accountId,
        { embeddingsApiKey },
        documentId,
        page.text,
      )
    } catch (err) {
      // The document is saved; only its (optional) semantic index
      // failed. Lexical search still works — count it and move on.
      const message = err instanceof AiError ? err.message : 'indexing failed'
      console.error(`[ai/knowledge import] ingest failed for ${page.url}:`, message)
      result.indexFailed++
    }
  }

  return result
}
