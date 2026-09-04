import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import {
  engineSendCarouselTemplate,
  engineSendProductList,
} from '@/lib/flows/meta-send'
import { buildProductCarouselCards } from '@/lib/products/carousel-cards'
import { buildProductCatalogRetailerIds } from '@/lib/products/catalog-sections'

const SESSION_WINDOW_HOURS = 24

// ============================================================
// GET /api/cron/re-engagement
//
// Runs the account-configured re-engagement stages every hour.
// Stages are edited from /agents → Re-engagement (table
// re_engagement_stages).
//
// Per stage:
//   * only contacts graded 'cold' (Phase 4) and not opted-out
//   * customer silent for at least `hours_after`
//   * silent for less than MAX_AGE_HOURS (7d default — abandon
//     truly dark contacts)
//   * this stage NOT already sent to this contact (idempotency
//     lives in contact_re_engagement_sends)
//
// For each match: send the stage's template — text or product
// carousel — and record the send row.
//
// One contact receives at most one stage per cron run (the loop
// breaks after the first match), so if multiple stages become
// eligible at the same moment (rare — happens if the cron missed
// several runs) the earliest wins; the others fire on the next
// hourly run.
//
// Auth: x-cron-secret header matches AUTOMATION_CRON_SECRET.
// Env: RE_ENGAGEMENT_MAX_AGE_HOURS (default 168 = 7d),
//      RE_ENGAGEMENT_BATCH_SIZE (default 100, cap 500).
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

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

interface StageRow {
  id: string
  account_id: string
  name: string
  hours_after: number
  template_name: string
  template_language: string
  template_type: 'text' | 'carousel' | 'catalog' | 'freeform_text'
  custom_text: string | null
}

interface ContactRow {
  id: string
  account_id: string
}

interface SentPair {
  contact_id: string
  stage_id: string
}

export async function GET(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const maxAgeHours = positiveIntEnv('RE_ENGAGEMENT_MAX_AGE_HOURS', 168)
  const batchSize = Math.min(positiveIntEnv('RE_ENGAGEMENT_BATCH_SIZE', 100), 500)

  const db = supabaseAdmin()
  const nowIso = new Date().toISOString()

  // ------------------------------------------------------------
  // 1. Pull every enabled stage across all accounts. In practice
  //    this is a handful of rows per account × a small number of
  //    accounts, so a single scan is fine.
  // ------------------------------------------------------------
  const { data: stagesRaw, error: stagesErr } = await db
    .from('re_engagement_stages')
    .select(
      'id, account_id, name, hours_after, template_name, template_language, template_type, custom_text',
    )
    .eq('enabled', true)
    .order('account_id', { ascending: true })
    .order('hours_after', { ascending: true })
  if (stagesErr) {
    console.error('[re-engagement] stages query failed:', stagesErr)
    return NextResponse.json({ error: stagesErr.message }, { status: 500 })
  }
  const stages = (stagesRaw ?? []) as StageRow[]
  if (stages.length === 0) {
    return NextResponse.json({ candidates: 0, sent: 0, failed: 0, stages: 0 })
  }

  // Group stages by account so we scan each account's cold
  // contacts once and consider all of that account's stages.
  const stagesByAccount = new Map<string, StageRow[]>()
  for (const s of stages) {
    const arr = stagesByAccount.get(s.account_id) ?? []
    arr.push(s)
    stagesByAccount.set(s.account_id, arr)
  }

  let sent = 0
  let failed = 0
  let attempted = 0
  const perStageSent: Record<string, number> = {}

  for (const [accountId, accountStages] of stagesByAccount.entries()) {
    if (attempted >= batchSize) break

    // Cold non-opted-out contacts for this account.
    const { data: contactsRaw, error: contactsErr } = await db
      .from('contacts')
      .select('id, account_id')
      .eq('account_id', accountId)
      .eq('lead_stage', 'cold')
      .is('opted_out_at', null)
      .limit(batchSize * 4)
    if (contactsErr) {
      console.warn(`[re-engagement] contacts query failed account=${accountId}:`, contactsErr)
      continue
    }
    const contacts = (contactsRaw ?? []) as ContactRow[]
    if (contacts.length === 0) continue

    // Bulk-fetch already-sent (contact_id, stage_id) pairs for
    // this account so per-contact loops don't re-query.
    const stageIds = accountStages.map((s) => s.id)
    const contactIds = contacts.map((c) => c.id)
    const { data: sentRows } = await db
      .from('contact_re_engagement_sends')
      .select('contact_id, stage_id')
      .eq('account_id', accountId)
      .in('stage_id', stageIds)
      .in('contact_id', contactIds)
    const sentSet = new Set(
      ((sentRows ?? []) as SentPair[]).map((r) => `${r.contact_id}:${r.stage_id}`),
    )

    const now = Date.now()

    for (const contact of contacts) {
      if (attempted >= batchSize) break

      // Most-recent conversation for this contact.
      const { data: recentConv } = await db
        .from('conversations')
        .select('id')
        .eq('contact_id', contact.id)
        .eq('account_id', accountId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
      if (!recentConv) continue
      const conversationId = (recentConv as { id: string }).id

      // Last customer-sent message on that thread.
      const { data: lastInbound } = await db
        .from('messages')
        .select('created_at')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!lastInbound) continue
      const hoursSince =
        (now - new Date((lastInbound as { created_at: string }).created_at).getTime()) /
        (60 * 60 * 1000)
      if (hoursSince >= maxAgeHours) continue

      // Iterate stages ascending — first match wins.
      for (const stage of accountStages) {
        if (hoursSince < stage.hours_after) continue
        if (sentSet.has(`${contact.id}:${stage.id}`)) continue

        // In-session types (catalog, freeform_text) only work
        // while the customer's 24h WhatsApp window is still open.
        // The API blocks configuring them with hours_after >= 24,
        // but check again defensively in case a stage was
        // reclassified after being saved — Meta silently drops
        // freeform sends outside the window.
        const inSession =
          stage.template_type === 'catalog' ||
          stage.template_type === 'freeform_text'
        if (inSession && hoursSince >= SESSION_WINDOW_HOURS) {
          console.warn(
            `[re-engagement] skip contact=${contact.id} stage=${stage.id} (${stage.template_type}): out of 24h session (${hoursSince.toFixed(1)}h)`,
          )
          continue
        }

        attempted += 1
        try {
          if (stage.template_type === 'carousel') {
            const cards = await buildProductCarouselCards(db, accountId)
            if (cards.length < 2) {
              throw new Error('carousel needs ≥2 products with images')
            }
            await engineSendCarouselTemplate({
              accountId,
              userId: '',
              conversationId,
              contactId: contact.id,
              templateName: stage.template_name,
              language: stage.template_language,
              bodyParams: ['there'],
              cards,
              summaryText: `Re-engagement carousel (${stage.name}): ${cards.length} products`,
            })
          } else if (stage.template_type === 'catalog') {
            const catalogId = process.env.WHATSAPP_CATALOG_ID
            if (!catalogId) {
              throw new Error('WHATSAPP_CATALOG_ID not set — catalog stage cannot fire')
            }
            const productRetailerIds = await buildProductCatalogRetailerIds(
              db,
              accountId,
            )
            if (productRetailerIds.length === 0) {
              throw new Error('no active products with variants to send')
            }
            const bodyText =
              (stage.custom_text ?? '').trim() ||
              "Hey! 🌿 Here's what we make at Vanamati — tap any product to see details."
            await engineSendProductList({
              accountId,
              userId: '',
              conversationId,
              contactId: contact.id,
              catalogId,
              bodyText,
              sections: [
                { title: 'Featured', productRetailerIds },
              ],
            })
          } else if (stage.template_type === 'freeform_text') {
            const bodyText = (stage.custom_text ?? '').trim()
            if (!bodyText) {
              throw new Error('freeform_text stage has empty custom_text')
            }
            await sendMessageToConversation(db, accountId, {
              conversationId,
              messageType: 'text',
              contentText: bodyText,
            })
          } else {
            // 'text' — Meta text template (any time), zero params.
            await sendMessageToConversation(db, accountId, {
              conversationId,
              messageType: 'template',
              templateName: stage.template_name,
              templateLanguage: stage.template_language,
              templateParams: [],
            })
          }
          await db.from('contact_re_engagement_sends').insert({
            contact_id: contact.id,
            stage_id: stage.id,
            account_id: accountId,
            sent_at: nowIso,
          })
          sent += 1
          perStageSent[stage.id] = (perStageSent[stage.id] ?? 0) + 1
        } catch (err) {
          failed += 1
          console.warn(
            `[re-engagement] send failed contact=${contact.id} stage=${stage.id} (${stage.name}):`,
            err instanceof Error ? err.message : err,
          )
        }
        break // one stage per contact per cron run
      }
    }
  }

  return NextResponse.json({
    candidates: attempted,
    sent,
    failed,
    stages: stages.length,
    accounts: stagesByAccount.size,
    perStageSent,
  })
}
