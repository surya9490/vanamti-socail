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

/**
 * Distinct crawl roots for a set of website-sourced docs: one origin
 * (scheme + host) per site, derived from each page's `source_url`.
 * Re-crawling from the origin (the homepage) with the same same-origin
 * rules is how both the weekly cron and the "Re-crawl now" button
 * refresh a site without the operator re-entering a URL. Malformed
 * URLs are skipped. Pure — tested directly.
 */
export function originsFromDocs(
  rows: Array<{ source_url: string | null }>,
): string[] {
  const set = new Set<string>()
  for (const r of rows) {
    if (!r.source_url) continue
    try {
      set.add(new URL(r.source_url).origin)
    } catch {
      /* skip malformed */
    }
  }
  return [...set]
}

export type RecrawlTargetResult =
  | ({ origin: string } & ImportSiteResult)
  | { origin: string; error: string }

export interface RecrawlResult {
  targets: number
  results: RecrawlTargetResult[]
}

/**
 * Re-import every website this account has previously imported.
 * Per-origin failures are captured in `results`, never thrown, so one
 * bad site can't block the others. Zero website docs → { targets: 0 }.
 */
export async function recrawlAccountWebsites(
  db: SupabaseClient,
  args: { accountId: string; userId: string; maxPages?: number },
): Promise<RecrawlResult> {
  const { data, error } = await db
    .from('ai_knowledge_documents')
    .select('source_url')
    .eq('account_id', args.accountId)
    .eq('source_type', 'website')
    .not('source_url', 'is', null)
  if (error) throw error

  const origins = originsFromDocs((data ?? []) as Array<{ source_url: string | null }>)
  const results: RecrawlTargetResult[] = []
  for (const origin of origins) {
    try {
      const r = await importSiteIntoKnowledge(db, {
        accountId: args.accountId,
        userId: args.userId,
        url: origin,
        maxPages: args.maxPages,
      })
      results.push({ origin, ...r })
    } catch (err) {
      results.push({
        origin,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { targets: origins.length, results }
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
