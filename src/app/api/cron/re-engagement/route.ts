import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { engineSendCarouselTemplate } from '@/lib/flows/meta-send'
import { buildProductCarouselCards } from '@/lib/products/carousel-cards'

// ============================================================
// GET /api/cron/re-engagement
//
// Two-stage COLD-lead re-engagement sweep. Fires two different
// templates at two different silence windows for contacts who
// reached out but never showed buying interest:
//
//   Stage 1 (default 3h):  RE_ENGAGEMENT_STAGE_1_TEMPLATE
//   Stage 2 (default 24h): RE_ENGAGEMENT_STAGE_2_TEMPLATE
//
// Eligibility per stage (each stage checked independently):
//   * opted_out_at IS NULL
//   * lead_stage = 'cold' (Phase 4 grading — customer showed
//     no buying intent; hot/warm leads are handled differently)
//   * conversation exists with at least one customer inbound
//   * hours since last inbound >= this stage's threshold AND
//     < the next-stage threshold (stage 1 window is [3h, 24h),
//     stage 2 window is [24h, MAX_AGE_HOURS])
//   * respective re_engagement_stage_N_at column IS NULL (never
//     been sent this stage before — idempotent)
//
// Each stage sends a MARKETING template into the contact's
// most-recent conversation and stamps the per-stage timestamp.
// Once a stage fires for a contact, it never fires again — the
// column is the idempotency key.
//
// Auth: x-cron-secret matches AUTOMATION_CRON_SECRET.
//
// Env config:
//   AUTOMATION_CRON_SECRET               shared secret (required)
//   RE_ENGAGEMENT_STAGE_1_TEMPLATE       required to enable stage 1
//   RE_ENGAGEMENT_STAGE_2_TEMPLATE       required to enable stage 2
//   RE_ENGAGEMENT_STAGE_1_HOURS          default 3
//   RE_ENGAGEMENT_STAGE_2_HOURS          default 24
//   RE_ENGAGEMENT_MAX_AGE_HOURS          default 168 (7 days)
//   RE_ENGAGEMENT_TEMPLATE_LANG          default 'en'
//   RE_ENGAGEMENT_BATCH_SIZE             default 100
//   RE_ENGAGEMENT_STAGE_1_TYPE           'text' (default) | 'carousel'
//   RE_ENGAGEMENT_STAGE_2_TYPE           'text' (default) | 'carousel'
//
// Carousel stages reuse the same Meta MARKETING carousel template
// the AI's send_product_carousel tool uses (per-card {{1}} = title,
// {{2}} = price; URL button {{1}} = handle; body {{1}} = "there").
// The cron builds cards from the account's product cache — same
// helper as the tool, so what customers see is identical.
//
// Missing BOTH stage template envs → 503 (feature off entirely).
// Missing ONE → that stage skipped, the other still runs.
//
// Cadence: run this cron HOURLY (Railway cron). Stage 1's 3h
// window is wide enough that hourly checks won't miss any
// candidate; if you want minute-level precision, run every 15m.
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

interface ContactRow {
  id: string
  account_id: string
  re_engagement_stage_1_at: string | null
  re_engagement_stage_2_at: string | null
}

type StageKey = 'stage_1' | 'stage_2'
type StageType = 'text' | 'carousel'

interface StageConfig {
  key: StageKey
  templateName: string
  templateType: StageType
  hoursMin: number
  hoursMax: number
  timestampColumn: 're_engagement_stage_1_at' | 're_engagement_stage_2_at'
}

function parseStageType(raw: string | undefined): StageType {
  return raw?.toLowerCase() === 'carousel' ? 'carousel' : 'text'
}

export async function GET(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const stage1Template = process.env.RE_ENGAGEMENT_STAGE_1_TEMPLATE
  const stage2Template = process.env.RE_ENGAGEMENT_STAGE_2_TEMPLATE
  if (!stage1Template && !stage2Template) {
    return NextResponse.json(
      {
        error:
          're-engagement not configured — set RE_ENGAGEMENT_STAGE_1_TEMPLATE and/or RE_ENGAGEMENT_STAGE_2_TEMPLATE to Meta-approved MARKETING templates',
      },
      { status: 503 },
    )
  }
  const templateLang = process.env.RE_ENGAGEMENT_TEMPLATE_LANG || 'en'
  const stage1Hours = positiveIntEnv('RE_ENGAGEMENT_STAGE_1_HOURS', 3)
  const stage2Hours = positiveIntEnv('RE_ENGAGEMENT_STAGE_2_HOURS', 24)
  const maxAgeHours = positiveIntEnv('RE_ENGAGEMENT_MAX_AGE_HOURS', 168)
  const batchSize = Math.min(positiveIntEnv('RE_ENGAGEMENT_BATCH_SIZE', 100), 500)

  // Assemble the enabled stages. Order matters — stage 1's window
  // ends where stage 2's begins.
  const stages: StageConfig[] = []
  if (stage1Template) {
    stages.push({
      key: 'stage_1',
      templateName: stage1Template,
      templateType: parseStageType(process.env.RE_ENGAGEMENT_STAGE_1_TYPE),
      hoursMin: stage1Hours,
      hoursMax: stage2Template ? stage2Hours : maxAgeHours,
      timestampColumn: 're_engagement_stage_1_at',
    })
  }
  if (stage2Template) {
    stages.push({
      key: 'stage_2',
      templateName: stage2Template,
      templateType: parseStageType(process.env.RE_ENGAGEMENT_STAGE_2_TYPE),
      hoursMin: stage2Hours,
      hoursMax: maxAgeHours,
      timestampColumn: 're_engagement_stage_2_at',
    })
  }

  const db = supabaseAdmin()
  const nowIso = new Date().toISOString()

  // Fetch cold, non-opted-out contacts with at least ONE stage
  // still eligible. Over-fetches because we then per-contact
  // check last-inbound age against each stage window.
  const { data: eligibleContacts, error: contactsErr } = await db
    .from('contacts')
    .select(
      'id, account_id, re_engagement_stage_1_at, re_engagement_stage_2_at',
    )
    .is('opted_out_at', null)
    .eq('lead_stage', 'cold')
    .or(
      're_engagement_stage_1_at.is.null,re_engagement_stage_2_at.is.null',
    )
    .limit(batchSize * 4)
  if (contactsErr) {
    console.error('[re-engagement] contact query failed:', contactsErr)
    return NextResponse.json({ error: contactsErr.message }, { status: 500 })
  }
  if (!eligibleContacts || eligibleContacts.length === 0) {
    return NextResponse.json({
      candidates: 0,
      sent: 0,
      failed: 0,
      stages: stages.map((s) => s.key),
    })
  }

  const now = Date.now()
  let sent = 0
  let failed = 0
  const perStageSent: Record<string, number> = {}
  const attempted: Array<{ contact_id: string; stage: string }> = []

  for (const rawRow of eligibleContacts) {
    if (attempted.length >= batchSize) break
    const row = rawRow as ContactRow
    const contactId = row.id
    const accountId = row.account_id

    // Pick the most-recent conversation for this contact.
    const { data: recentConv } = await db
      .from('conversations')
      .select('id')
      .eq('contact_id', contactId)
      .eq('account_id', accountId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    if (!recentConv) continue
    const conversationId = (recentConv as { id: string }).id

    // Last CUSTOMER-sent message on that thread.
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

    // Consider each enabled stage in order. The first one that
    // matches wins (a single contact never gets two templates in
    // one cron run — the second stage will fire on a later run
    // once its own window opens for THAT contact).
    for (const stage of stages) {
      const alreadySent =
        stage.key === 'stage_1'
          ? row.re_engagement_stage_1_at != null
          : row.re_engagement_stage_2_at != null
      if (alreadySent) continue
      if (hoursSince < stage.hoursMin) continue
      if (hoursSince >= stage.hoursMax) continue

      attempted.push({ contact_id: contactId, stage: stage.key })
      try {
        if (stage.templateType === 'carousel') {
          const cards = await buildProductCarouselCards(db, accountId)
          if (cards.length < 2) {
            // Not enough eligible products to fill a carousel —
            // fail this contact for this run rather than sending a
            // malformed template. Don't stamp the timestamp so it
            // gets retried on the next run once inventory allows.
            throw new Error('carousel needs ≥2 products with images; none found')
          }
          await engineSendCarouselTemplate({
            accountId,
            userId: '',
            conversationId,
            contactId,
            templateName: stage.templateName,
            language: templateLang,
            bodyParams: ['there'],
            cards,
            summaryText: `Re-engagement carousel (${stage.key}): ${cards.length} products`,
          })
        } else {
          await sendMessageToConversation(db, accountId, {
            conversationId,
            messageType: 'template',
            templateName: stage.templateName,
            templateLanguage: templateLang,
            templateParams: [],
          })
        }
        await db
          .from('contacts')
          .update({ [stage.timestampColumn]: nowIso })
          .eq('id', contactId)
          .eq('account_id', accountId)
        sent += 1
        perStageSent[stage.key] = (perStageSent[stage.key] ?? 0) + 1
      } catch (err) {
        failed += 1
        console.warn(
          `[re-engagement] send failed contact=${contactId} stage=${stage.key}:`,
          err instanceof Error ? err.message : err,
        )
      }
      break // one stage per contact per cron run
    }
  }

  return NextResponse.json({
    candidates: attempted.length,
    sent,
    failed,
    perStageSent,
    stages: stages.map((s) => ({
      key: s.key,
      template: s.templateName,
      type: s.templateType,
      window_hours: [s.hoursMin, s.hoursMax],
    })),
  })
}
