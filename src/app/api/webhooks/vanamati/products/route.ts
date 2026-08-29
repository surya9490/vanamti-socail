import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/auth/api-context'
import { toApiErrorResponse } from '@/lib/api/v1/respond'
import { upsertProduct, deactivateProduct } from '@/lib/products/upsert'
import type { ProductWebhookPayload } from '@/lib/products/types'

// ============================================================
// POST /api/webhooks/vanamati/products
//
// One product event per POST, sent by the Vanamati Shopify app when
// its products/create, products/update or products/delete webhook
// fires in Shopify. The app transforms Shopify's payload into the
// stable shape below.
//
// Auth: Authorization: Bearer <WACRM_API_KEY> with 'products:write'
// scope. The API key's account is used as the target — the caller
// does NOT send an account_id (it would just get overwritten anyway,
// and letting a key push into a different account would defeat the
// per-account isolation this codebase is built on).
//
// Body:
//   { event: 'created' | 'updated' | 'deleted',
//     product: { shop_product_id, title, price_min, ... } }
//
// Response: JSON, 2xx = delivered. 5xx = server error (sender should
// retry — upserts are idempotent on account_id + shop_product_id).
// ============================================================

export async function POST(request: Request): Promise<Response> {
  let ctx
  try {
    ctx = await requireApiKey(request, 'products:write')
  } catch (err) {
    return toApiErrorResponse(err)
  }

  let payload: ProductWebhookPayload
  try {
    payload = (await request.json()) as ProductWebhookPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    !payload.product ||
    typeof payload.product.shop_product_id !== 'string'
  ) {
    return NextResponse.json(
      { error: 'product.shop_product_id is required' },
      { status: 400 },
    )
  }

  if (
    payload.event !== 'created' &&
    payload.event !== 'updated' &&
    payload.event !== 'deleted'
  ) {
    return NextResponse.json(
      { error: 'event must be created | updated | deleted' },
      { status: 400 },
    )
  }

  try {
    if (payload.event === 'deleted') {
      await deactivateProduct(
        ctx.supabase,
        ctx.accountId,
        payload.product.shop_product_id,
      )
    } else {
      await upsertProduct(ctx.supabase, ctx.accountId, payload.product)
    }
  } catch (err) {
    console.error('[vanamati webhook] products upsert failed:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
