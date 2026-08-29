import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyVanamatiWebhookSignature } from '@/lib/products/webhook-auth'
import { upsertProduct, deactivateProduct } from '@/lib/products/upsert'
import type { ProductWebhookPayload } from '@/lib/products/types'

// ============================================================
// POST /api/webhooks/vanamati/products
//
// One product event per POST, sent by the Vanamati Shopify app when
// its products/create, products/update or products/delete webhook
// fires in Shopify. The app transforms Shopify's payload into the
// stable shape below before signing and posting.
//
// Body:
//   { event: 'created' | 'updated' | 'deleted',
//     account_id: '<WACRM account uuid>',
//     product: { shop_product_id, title, price_min, ... } }
//
// Auth: HMAC-SHA256 of the raw body in `x-vanamati-signature`, using
// VANAMATI_WEBHOOK_SECRET. Missing secret → 401 (fail closed).
//
// Response is always JSON; a 2xx tells the sender it's safe to
// consider this event delivered. Server-side errors return 5xx so
// the Vanamati app can retry.
// ============================================================

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

  let payload: ProductWebhookPayload
  try {
    payload = JSON.parse(rawBody) as ProductWebhookPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.account_id !== 'string' ||
    !payload.product ||
    typeof payload.product.shop_product_id !== 'string'
  ) {
    return NextResponse.json(
      { error: 'account_id and product.shop_product_id are required' },
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

  const db = supabaseAdmin()
  try {
    if (payload.event === 'deleted') {
      await deactivateProduct(
        db,
        payload.account_id,
        payload.product.shop_product_id,
      )
    } else {
      await upsertProduct(db, payload.account_id, payload.product)
    }
  } catch (err) {
    console.error('[vanamati webhook] products upsert failed:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
