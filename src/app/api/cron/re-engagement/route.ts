import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import {
  engineSendCarouselTemplate,
  engineSendProductList,
} from '@/lib/flows/meta-send'
import { buildProductCarouselCards } from '@/lib/products/carousel-cards'
import { buildProductCatalog } from '@/lib/products/catalog-sections'
import {
  evaluateThread,
  findSalesStage,
  isQuietHour,
  localHour,
  type SessionMessage,
  type SkipReason,
} from '@/lib/ai/re-engagement'
import { fetchRecentCustomerVerdict } from '@/lib/ai/recent-customer.server'

const SESSION_WINDOW_HOURS = 24

// ============================================================
// GET /api/cron/re-engagement
//
// Runs the account-configured re-engagement stages every hour.
// Stages are edited from /agents → Re-engagement (table
// re_engagement_stages).
//
// Per stage:
//   * any non-opted-out contact whose thread went quiet on THEIR
//     side after OUR last message — lead grade is not a filter
//     (see lib/ai/re-engagement.ts for the rails: open thread, AI
//     not paused, customer has spoken, last message is ours and
//     not a transactional template)
//   * customer silent for at least `hours_after`
//   * silent for less than MAX_AGE_HOURS (7d default — abandon
//     truly dark contacts)
//   * this stage NOT already sent to this contact (idempotency
//     lives in contact_re_engagement_sends)
//
// Nothing is sent during quiet hours (default 22:00–08:00
// Asia/Kolkata); the run simply returns and the stage fires on the
// next hourly run outside the window.
//
// `?dry_run=1` evaluates everything and lists who would get which
// stage without sending or recording anything.
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
//      RE_ENGAGEMENT_BATCH_SIZE (default 100, cap 500),
//      RE_ENGAGEMENT_TIMEZONE (default Asia/Kolkata),
//      RE_ENGAGEMENT_QUIET_START / _END (local hours, default 22 / 8;
//      equal values disable quiet hours).
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

/** A local hour 0–23; anything else falls back. */
function hourEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback
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
  const dryRun = new URL(request.url).searchParams.get('dry_run') === '1'

  const timeZone = process.env.RE_ENGAGEMENT_TIMEZONE || 'Asia/Kolkata'
  const quietStart = hourEnv('RE_ENGAGEMENT_QUIET_START', 22)
  const quietEnd = hourEnv('RE_ENGAGEMENT_QUIET_END', 8)
  const startedAt = new Date()
  if (!dryRun && isQuietHour(startedAt, timeZone, quietStart, quietEnd)) {
    return NextResponse.json({
      skipped: 'quiet_hours',
      local_hour: localHour(startedAt, timeZone),
      time_zone: timeZone,
      candidates: 0,
      sent: 0,
      failed: 0,
    })
  }

  const db = supabaseAdmin()
  const nowIso = startedAt.toISOString()

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
  const skipped: Partial<Record<SkipReason, number>> = {}
  const candidates: {
    contact_id: string
    conversation_id: string
    stage: string
    type: string
    hours_since: number
  }[] = []

  for (const [accountId, accountStages] of stagesByAccount.entries()) {
    if (attempted >= batchSize) break

    // Every non-opted-out contact for this account, most recently
    // active first. Lead grade is NOT a filter — see
    // lib/ai/re-engagement.ts; evaluateThread() below holds the
    // per-thread safety rails.
    const { data: contactsRaw, error: contactsErr } = await db
      .from('contacts')
      .select('id, account_id')
      .eq('account_id', accountId)
      .is('opted_out_at', null)
      .order('updated_at', { ascending: false, nullsFirst: false })
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

    const now = startedAt.getTime()

    // Our own re-engagement templates don't count as "transactional"
    // when they're the last thing on a thread — stage 2 must be able
    // to follow stage 1.
    const stageTemplateNames = new Set(
      accountStages
        .filter((s) => s.template_type === 'text' || s.template_type === 'carousel')
        .map((s) => s.template_name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0),
    )
    // …and our freeform stage bodies, so a check-in we already sent
    // isn't mistaken for (or hides) the thread's sales stage.
    const stageTexts = new Set(
      accountStages
        .map((s) => (s.custom_text ?? '').trim())
        .filter((t) => t.length > 0),
    )

    for (const contact of contacts) {
      if (attempted >= batchSize) break

      // Most-recent conversation for this contact.
      const { data: recentConv } = await db
        .from('conversations')
        .select('id, status, ai_autoreply_disabled')
        .eq('contact_id', contact.id)
        .eq('account_id', accountId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
      if (!recentConv) continue
      const conv = recentConv as {
        id: string
        status: string | null
        ai_autoreply_disabled: boolean | null
      }
      const conversationId = conv.id

      // Latest message on the thread (any sender) and the customer's
      // latest — together they say whether the customer is the quiet
      // party and for how long.
      const [{ data: lastAny }, { data: lastInbound }] = await Promise.all([
        db
          .from('messages')
          .select('sender_type, content_type, template_name')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        db
          .from('messages')
          .select('created_at')
          .eq('conversation_id', conversationId)
          .eq('sender_type', 'customer')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
      const last = lastAny as {
        sender_type: string | null
        content_type: string | null
        template_name: string | null
      } | null
      const lastCustomerAt =
        (lastInbound as { created_at: string } | null)?.created_at ?? null

      // Sales stage of the current session + recent-customer check.
      // Both only matter once the cheap gates above would pass, but
      // they're needed for the verdict, so load them when the thread
      // has a customer message at all.
      let salesStage: ReturnType<typeof findSalesStage> = null
      let recentCustomer = false
      if (lastCustomerAt) {
        const sessionSince = new Date(
          new Date(lastCustomerAt).getTime() - SESSION_WINDOW_HOURS * 3_600_000,
        ).toISOString()
        const [{ data: sessionRows }, { data: nudgeRows }, recent] = await Promise.all([
          db
            .from('messages')
            .select('id, sender_type, content_type, content_text, template_name, created_at')
            .eq('conversation_id', conversationId)
            .gte('created_at', sessionSince)
            .order('created_at', { ascending: false })
            .limit(40),
          db
            .from('conversation_close_nudges')
            .select('message_id')
            .eq('conversation_id', conversationId),
          fetchRecentCustomerVerdict(db, conversationId, now),
        ])
        const session: SessionMessage[] = (
          (sessionRows ?? []) as {
            id: string
            sender_type: string | null
            content_type: string | null
            content_text: string | null
            template_name: string | null
            created_at: string
          }[]
        ).map((r) => ({
          id: r.id,
          senderType: r.sender_type,
          contentType: r.content_type,
          contentText: r.content_text,
          templateName: r.template_name,
          createdAt: r.created_at,
        }))
        const nudgeIds = new Set(
          ((nudgeRows ?? []) as { message_id: string | null }[])
            .map((r) => r.message_id)
            .filter((id): id is string => Boolean(id)),
        )
        salesStage = findSalesStage(session, {
          lastCustomerAt,
          sessionHours: SESSION_WINDOW_HOURS,
          ignoreMessageIds: nudgeIds,
          ignoreTexts: stageTexts,
          stageTemplateNames,
        })
        recentCustomer = recent.recent
      }

      const verdict = evaluateThread(
        {
          conversationStatus: conv.status,
          aiAutoreplyDisabled: conv.ai_autoreply_disabled,
          salesStage,
          recentCustomer,
          lastMessage: last
            ? {
                senderType: last.sender_type,
                contentType: last.content_type,
                templateName: last.template_name,
              }
            : null,
          lastCustomerMessageAt: lastCustomerAt,
        },
        { now, maxAgeHours, stageTemplateNames },
      )
      if (!verdict.eligible) {
        skipped[verdict.reason] = (skipped[verdict.reason] ?? 0) + 1
        continue
      }
      const { hoursSince } = verdict

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
        if (dryRun) {
          candidates.push({
            contact_id: contact.id,
            conversation_id: conversationId,
            stage: stage.name,
            type: stage.template_type,
            hours_since: Number(hoursSince.toFixed(1)),
          })
          break
        }
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
            const { retailerIds: productRetailerIds, meta: previewProducts } =
              await buildProductCatalog(db, accountId)
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
              previewProducts,
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
    skipped,
    ...(dryRun ? { dry_run: true, would_send: candidates } : {}),
  })
}
