import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProductWebhookPayload } from './types'

// ============================================================
// Product-cache mutations. Called from both the streaming webhook
// (single product per POST) and the backfill endpoint (bulk push).
// Uses the service-role client — bypasses RLS on purpose, since the
// signature has already been verified upstream.
// ============================================================

/**
 * Insert or update one product. Idempotent — safe to call for the
 * same shop_product_id repeatedly (upsert on the account_id +
 * shop_product_id unique index).
 */
export async function upsertProduct(
  db: SupabaseClient,
  accountId: string,
  input: ProductWebhookPayload['product'],
): Promise<void> {
  const row = {
    account_id: accountId,
    shop_product_id: input.shop_product_id,
    handle: input.handle ?? null,
    title: input.title ?? '(untitled)',
    description: input.description ?? null,
    price_min: input.price_min ?? null,
    price_max: input.price_max ?? null,
    currency: input.currency ?? 'INR',
    product_url: input.product_url ?? null,
    image_url: input.image_url ?? null,
    tags: input.tags ?? [],
    product_type: input.product_type ?? null,
    // Missing is_active defaults to true — Shopify's default publishing
    // state; the Vanamati transformer sets false only when the product
    // is drafted / archived.
    is_active: input.is_active ?? true,
    variants: input.variants ?? [],
    synced_at: new Date().toISOString(),
  }
  const { error } = await db
    .from('products')
    .upsert(row, { onConflict: 'account_id,shop_product_id' })
  if (error) throw error
}

/**
 * Soft-delete: flip is_active to false rather than physically
 * removing the row. Why: an AI reply that happened seconds ago may
 * still be quoting the product; keeping it around lets the inbox
 * render the past reference. Hard purges can happen from an admin
 * sweep later if needed.
 */
export async function deactivateProduct(
  db: SupabaseClient,
  accountId: string,
  shopProductId: string,
): Promise<void> {
  const { error } = await db
    .from('products')
    .update({ is_active: false, synced_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('shop_product_id', shopProductId)
  if (error) throw error
}

/**
 * Bulk upsert for the cold-start backfill. Sent in one call so the
 * sender can trickle the catalogue through in reasonable batches
 * (Vanamati app decides the batch size to keep the request body
 * under Vercel's 4.5MB limit).
 */
export async function upsertProductsBulk(
  db: SupabaseClient,
  accountId: string,
  inputs: ProductWebhookPayload['product'][],
): Promise<void> {
  if (inputs.length === 0) return
  const now = new Date().toISOString()
  const rows = inputs.map((input) => ({
    account_id: accountId,
    shop_product_id: input.shop_product_id,
    handle: input.handle ?? null,
    title: input.title ?? '(untitled)',
    description: input.description ?? null,
    price_min: input.price_min ?? null,
    price_max: input.price_max ?? null,
    currency: input.currency ?? 'INR',
    product_url: input.product_url ?? null,
    image_url: input.image_url ?? null,
    tags: input.tags ?? [],
    product_type: input.product_type ?? null,
    is_active: input.is_active ?? true,
    variants: input.variants ?? [],
    synced_at: now,
  }))
  const { error } = await db
    .from('products')
    .upsert(rows, { onConflict: 'account_id,shop_product_id' })
  if (error) throw error
}
