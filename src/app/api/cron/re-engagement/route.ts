import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

// ============================================================
// GET /api/cron/re-engagement
//
// Silence-based re-engagement sweep. Once per cron tick, we find
// contacts who:
//   * are NOT opted out (opted_out_at IS NULL)
//   * last inbounded > RE_ENGAGEMENT_SILENCE_DAYS days ago
//   * inbound was within RE_ENGAGEMENT_MAX_AGE_DAYS (skip customers
//     who went dark >90 days ago — they're likely gone and we
//     don't want to spam them out of nowhere)
//   * have NOT been re-engaged in the last
//     RE_ENGAGEMENT_COOLDOWN_DAYS days
//
// For each candidate we send a Meta MARKETING template
// (RE_ENGAGEMENT_TEMPLATE_NAME) into the contact's most-recent
// conversation and stamp `last_re_engagement_at`.
//
// Why a MARKETING template: the 24hr WhatsApp session window is
// closed by the time we're re-engaging (>7 days silence), so
// freeform text is not allowed by Meta policy — a MARKETING
// category template pre-approved in Meta's dashboard is the ONLY
// legal way to initiate this. UTILITY templates are for order/
// account updates, not promotional re-engagement.
//
// Auth: x-cron-secret matches AUTOMATION_CRON_SECRET (reused —
// same env var the automations/flows cron uses).
//
// Env config (all optional except the template name):
//   AUTOMATION_CRON_SECRET               shared secret
//   RE_ENGAGEMENT_TEMPLATE_NAME          required, Meta template name
//   RE_ENGAGEMENT_TEMPLATE_LANG          default 'en'
//   RE_ENGAGEMENT_SILENCE_DAYS           default 7
//   RE_ENGAGEMENT_COOLDOWN_DAYS          default 30
//   RE_ENGAGEMENT_MAX_AGE_DAYS           default 90
//   RE_ENGAGEMENT_BATCH_SIZE             default 100
//
// Missing RE_ENGAGEMENT_TEMPLATE_NAME → 503, so the feature is
// off-by-default: operators enable it explicitly by setting the
// template name (after registering + approving it in Meta).
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

interface CandidateRow {
  contact_id: string
  account_id: string
  conversation_id: string
  contact_phone: string | null
}

export async function GET(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const templateName = process.env.RE_ENGAGEMENT_TEMPLATE_NAME
  if (!templateName) {
    return NextResponse.json(
      {
        error:
          're-engagement not configured — set RE_ENGAGEMENT_TEMPLATE_NAME to a Meta-approved MARKETING template',
      },
      { status: 503 },
    )
  }
  const templateLang = process.env.RE_ENGAGEMENT_TEMPLATE_LANG || 'en'
  const silenceDays = positiveIntEnv('RE_ENGAGEMENT_SILENCE_DAYS', 7)
  const cooldownDays = positiveIntEnv('RE_ENGAGEMENT_COOLDOWN_DAYS', 30)
  const maxAgeDays = positiveIntEnv('RE_ENGAGEMENT_MAX_AGE_DAYS', 90)
  const batchSize = Math.min(positiveIntEnv('RE_ENGAGEMENT_BATCH_SIZE', 100), 500)

  const db = supabaseAdmin()

  // Candidate query. Two LATERAL joins per contact:
  //   1. last customer inbound (messages.sender_type='customer') for
  //      the silence-age check
  //   2. most-recent conversation for that contact, to route the
  //      template send into
  // Filtered: not opted out, cooldown expired, inbound is between
  // (silenceDays, maxAgeDays) days ago.
  //
  // No RPC — inline SQL via supabase-js `rpc('exec_raw_sql')` isn't
  // available here, so we use a stored function. To avoid another
  // migration for a one-off select, we compose the filter in JS
  // and issue two round-trips: (a) list eligible contact_ids based
  // on the simple filters, (b) for each, resolve conversation +
  // last-inbound in one batched query. This trades one SELECT for
  // per-contact clarity and keeps the migration surface tiny.
  //
  // At Vanamati's scale (< 10k contacts) this is fine. If contacts
  // grows past ~50k we should replace with a SQL function that
  // does the JOIN in one shot.
  const nowIso = new Date().toISOString()
  const cooldownCutoff = new Date(
    Date.now() - cooldownDays * 24 * 60 * 60 * 1000,
  ).toISOString()

  const { data: eligibleContacts, error: contactsErr } = await db
    .from('contacts')
    .select('id, account_id, phone, last_re_engagement_at')
    .is('opted_out_at', null)
    .or(
      `last_re_engagement_at.is.null,last_re_engagement_at.lt.${cooldownCutoff}`,
    )
    .limit(batchSize * 4) // over-fetch since some rows will filter out on silence-age
  if (contactsErr) {
    console.error('[re-engagement] contact query failed:', contactsErr)
    return NextResponse.json({ error: contactsErr.message }, { status: 500 })
  }
  if (!eligibleContacts || eligibleContacts.length === 0) {
    return NextResponse.json({ candidates: 0, attempted: 0, sent: 0, failed: 0 })
  }

  const silenceCutoff = new Date(
    Date.now() - silenceDays * 24 * 60 * 60 * 1000,
  ).toISOString()
  const maxAgeCutoff = new Date(
    Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString()

  const candidates: CandidateRow[] = []

  for (const row of eligibleContacts) {
    if (candidates.length >= batchSize) break
    const contactId = row.id as string
    const accountId = row.account_id as string
    const phone = (row as { phone?: string }).phone ?? null

    // Route into the most recently active conversation. Also gives
    // us the conversation ids we need to check for last inbound.
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

    // Last CUSTOMER-sent message on that conversation.
    // (Vanamati is B2C-ish and contacts typically have one active
    // thread; if they have several old ones the newest one is the
    // right routing target and the right silence-age reference.)
    const { data: lastInbound } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!lastInbound) continue // never inbounded on this thread
    const createdAt = (lastInbound as { created_at: string }).created_at
    if (createdAt >= silenceCutoff) continue // too recent, still active
    if (createdAt < maxAgeCutoff) continue // too old, don't spam-revive

    candidates.push({
      contact_id: contactId,
      account_id: accountId,
      conversation_id: conversationId,
      contact_phone: phone,
    })
  }

  let sent = 0
  let failed = 0
  for (const c of candidates) {
    try {
      await sendMessageToConversation(db, c.account_id, {
        conversationId: c.conversation_id,
        messageType: 'template',
        templateName,
        templateLanguage: templateLang,
        // No template params by default; the template's body must
        // not have any variables OR should have safe defaults.
        // Extend here once we standardise on a template shape.
        templateParams: [],
      })
      await db
        .from('contacts')
        .update({ last_re_engagement_at: nowIso })
        .eq('id', c.contact_id)
        .eq('account_id', c.account_id)
      sent += 1
    } catch (err) {
      failed += 1
      console.warn(
        `[re-engagement] send failed for contact ${c.contact_id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return NextResponse.json({
    candidates: candidates.length,
    attempted: candidates.length,
    sent,
    failed,
    silenceDays,
    cooldownDays,
    maxAgeDays,
  })
}
