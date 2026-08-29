import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyVanamatiWebhookSignature } from '@/lib/products/webhook-auth'
import { upsertProductsBulk } from '@/lib/products/upsert'
import type { ProductBackfillPayload } from '@/lib/products/types'

// ============================================================
// POST /api/backfill/products
//
// Cold-start / periodic reconciliation endpoint. The Vanamati
// Shopify app pushes the full product catalogue in batches on:
//   * first install (before any webhooks have fired)
//   * a nightly diff-sync (catches events dropped from webhook failures)
//   * an operator-triggered "rebuild cache" action
//
// Body:
//   { account_id: '<WACRM account uuid>',
//     products: [ {shop_product_id, title, ...}, ... ] }
//
// Auth: same HMAC scheme as the streaming webhook (reuses
// VANAMATI_WEBHOOK_SECRET).
//
// Batch size is the sender's call — we upsert whatever arrives in a
// single Postgres statement. If the batch is too big for the
// platform's request-body cap, the sender chunks and calls this
// endpoint multiple times.
// ============================================================

// Product batches can be large — allow the whole request body up to
// Vercel's cap (4.5MB by default) and give the handler headroom.
export const maxDuration = 60

let _adminClient: ReturnType<typeof createClient> | null = null
function supabaseAdmin(): ReturnType<typeof createClient> {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text()
  const signature = request.headers.get('x-vanamati-signature')

  if (!verifyVanamatiWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let payload: ProductBackfillPayload
  try {
    payload = JSON.parse(rawBody) as ProductBackfillPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (
    !payload ||
    typeof payload.account_id !== 'string' ||
    !Array.isArray(payload.products)
  ) {
    return NextResponse.json(
      { error: 'account_id and products[] are required' },
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

  const db = supabaseAdmin()
  try {
    await upsertProductsBulk(db, payload.account_id, clean)
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
