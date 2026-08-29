import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/auth/api-context'
import { toApiErrorResponse } from '@/lib/api/v1/respond'
import { upsertProductsBulk } from '@/lib/products/upsert'
import type { ProductBackfillPayload } from '@/lib/products/types'

// ============================================================
// POST /api/backfill/products
//
// Cold-start / periodic reconciliation. The Vanamati Shopify app
// pushes the full product catalogue in batches on:
//   * first install (before any webhooks have fired)
//   * a nightly diff-sync (catches events dropped from webhook failures)
//   * an operator-triggered "rebuild cache" action
//
// Auth: same as the streaming webhook — Authorization: Bearer
// <WACRM_API_KEY> with 'products:write' scope. Target account is the
// key's account.
//
// Body:
//   { products: [ {shop_product_id, title, ...}, ... ] }
//
// Batch size is the sender's call — we upsert whatever arrives in a
// single Postgres statement. If the batch exceeds the platform's
// request-body cap, the sender chunks and calls this endpoint
// multiple times.
// ============================================================

// Backfill batches can be large — Vercel clamps to the plan ceiling.
export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  let ctx
  try {
    ctx = await requireApiKey(request, 'products:write')
  } catch (err) {
    return toApiErrorResponse(err)
  }

  let payload: ProductBackfillPayload
  try {
    payload = (await request.json()) as ProductBackfillPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!payload || !Array.isArray(payload.products)) {
    return NextResponse.json(
      { error: 'products[] is required' },
      { status: 400 },
    )
  }

  // Drop entries missing the upsert key rather than 400ing the whole
  // batch — a single malformed row shouldn't force the sender to
  // retry all N.
  const clean = payload.products.filter(
    (p) => p && typeof p.shop_product_id === 'string',
  )
  const dropped = payload.products.length - clean.length

  try {
    await upsertProductsBulk(ctx.supabase, ctx.accountId, clean)
  } catch (err) {
    console.error('[vanamati backfill] bulk upsert failed:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    upserted: clean.length,
    dropped_invalid: dropped,
  })
}
