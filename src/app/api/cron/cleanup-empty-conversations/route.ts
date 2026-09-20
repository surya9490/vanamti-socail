import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { isOrphanContact, ORPHAN_MIN_AGE_MS } from '@/lib/conversations/orphans'

// ============================================================
// GET /api/cron/cleanup-empty-conversations
//
// Hourly sweep of "No messages yet" conversation shells. These appear
// when an outbound send created the contact + conversation and then
// never completed — the inline rollback in /api/v1/messages catches
// Meta rejections, but not a process that died mid-request (observed:
// 502s from the Vanamati app's 5-minute notify scheduler).
//
// For each conversation with last_message_at IS NULL older than the
// grace period:
//   1. re-check it really has zero messages (never trust the cached
//      column alone), then delete it;
//   2. if the contact now has no conversations, no tags, no broadcast
//      history and no real name (name == phone / empty), delete the
//      contact too — it was an API default nobody typed. Anything an
//      agent named, tagged, or broadcast to is left alone.
//
// Auth: x-cron-secret matches AUTOMATION_CRON_SECRET.
// Env:  ORPHAN_SWEEP_BATCH  default 200 (per run).
// Cadence: hourly (Railway `30 * * * *`).
// ============================================================

function verifyCronSecret(request: Request): boolean {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return false
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

interface ConvRow {
  id: string
  account_id: string
  contact_id: string
  created_at: string
}

export async function GET(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const batchRaw = Number(process.env.ORPHAN_SWEEP_BATCH)
  const batch = Number.isFinite(batchRaw) && batchRaw > 0 ? Math.min(batchRaw, 1000) : 200
  const cutoff = new Date(Date.now() - ORPHAN_MIN_AGE_MS).toISOString()

  const { data: rows, error } = await db
    .from('conversations')
    .select('id, account_id, contact_id, created_at')
    .is('last_message_at', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(batch)
  if (error) {
    console.error('[cleanup-empty-conversations] query failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let conversationsDeleted = 0
  let contactsDeleted = 0
  let skippedHasMessages = 0
  const deleted: Array<{ conversation_id: string; contact_deleted: boolean }> = []

  for (const c of (rows ?? []) as ConvRow[]) {
    const { count: msgCount } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', c.id)
    if ((msgCount ?? 0) > 0) {
      // last_message_at is stale but the thread isn't empty — leave it.
      skippedHasMessages++
      continue
    }

    const { error: delConvErr } = await db
      .from('conversations')
      .delete()
      .eq('id', c.id)
      .eq('account_id', c.account_id)
    if (delConvErr) {
      console.warn(`[cleanup-empty-conversations] delete conv ${c.id} failed:`, delConvErr)
      continue
    }
    conversationsDeleted++

    // Contact: only if it's an unnamed, untagged, never-broadcast API stub.
    const [{ data: contact }, { count: remaining }, { count: tags }, { count: recipients }] =
      await Promise.all([
        db.from('contacts').select('name, phone').eq('id', c.contact_id).maybeSingle(),
        db.from('conversations').select('id', { count: 'exact', head: true }).eq('contact_id', c.contact_id),
        db.from('contact_tags').select('contact_id', { count: 'exact', head: true }).eq('contact_id', c.contact_id),
        db.from('broadcast_recipients').select('id', { count: 'exact', head: true }).eq('contact_id', c.contact_id),
      ])

    let contactDeleted = false
    if (
      contact &&
      isOrphanContact({
        name: (contact as { name?: string | null }).name ?? null,
        phone: (contact as { phone: string }).phone,
        remainingConversations: remaining ?? 0,
        tags: tags ?? 0,
        broadcastRecipients: recipients ?? 0,
      })
    ) {
      const { error: delContactErr } = await db
        .from('contacts')
        .delete()
        .eq('id', c.contact_id)
        .eq('account_id', c.account_id)
      contactDeleted = !delContactErr
      if (contactDeleted) contactsDeleted++
    }
    deleted.push({ conversation_id: c.id, contact_deleted: contactDeleted })
  }

  if (conversationsDeleted > 0) {
    console.log(
      `[cleanup-empty-conversations] deleted ${conversationsDeleted} empty conversations, ${contactsDeleted} stub contacts (skipped ${skippedHasMessages} with messages)`,
    )
  }

  return NextResponse.json({
    scanned: rows?.length ?? 0,
    conversations_deleted: conversationsDeleted,
    contacts_deleted: contactsDeleted,
    skipped_has_messages: skippedHasMessages,
    min_age_hours: ORPHAN_MIN_AGE_MS / 3_600_000,
    deleted,
  })
}
