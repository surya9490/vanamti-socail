import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { engineSendText } from '@/lib/flows/meta-send'
import { detectCloseStage, pickNextNudge, STAGE_CONFIG } from '@/lib/ai/close-nudge'

// ============================================================
// GET /api/cron/close-nudge
//
// Every-minute cron that automates the manual "did you get my
// message?" nudges an agent sends when a customer goes silent
// right before completing an order.
//
// Fires on THREE stages, identified by the bot's most recent
// outgoing text:
//   1. address_ask       — bot asked for the shipping address
//   2. address_confirm   — bot showed summary + "Ready?"
//   3. payment_link_sent — bot handed over the checkout URL
//
// For each candidate conversation the cron checks:
//   * ai_autoreply_disabled = false (AI not paused; a handoff
//     means a human is handling, don't step on their toes)
//   * conversations.status = 'open'
//   * Contact has NOT opted out
//   * The most recent MESSAGE in the thread is a BOT message
//     whose text matches one of the stage patterns
//   * No customer inbound has arrived since that bot message
//   * hours_since_bot_message < MAX_STALE_HOURS (6h default —
//     if they've been silent that long it's not a live close)
//   * Per-stage cadence has elapsed (1 min / 3 min / etc.)
//   * Fewer than the per-stage max nudges already sent for THIS
//     specific triggering bot message
//
// Cron cadence: run every minute (`* * * * *` on Railway).
//
// Env:
//   AUTOMATION_CRON_SECRET      shared secret (required)
//   CLOSE_NUDGE_MAX_STALE_HOURS default 6 — abandon threads
//                               silent longer than this
//   CLOSE_NUDGE_BATCH_SIZE      default 50 — per-run cap
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

interface RecentBotRow {
  id: string
  conversation_id: string
  content_text: string | null
  created_at: string
}

interface ConversationRow {
  id: string
  account_id: string
  contact_id: string
  ai_autoreply_disabled: boolean | null
}

interface ContactRow {
  id: string
  opted_out_at: string | null
}

export async function GET(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const maxStaleHours = positiveIntEnv('CLOSE_NUDGE_MAX_STALE_HOURS', 6)
  const batchSize = Math.min(positiveIntEnv('CLOSE_NUDGE_BATCH_SIZE', 50), 200)

  const db = supabaseAdmin()
  const now = new Date()
  const staleCutoff = new Date(now.getTime() - maxStaleHours * 60 * 60 * 1000)

  // ------------------------------------------------------------
  // 1. Bulk-fetch every message_id we've already used as a NUDGE
  //    inside the stale window. Nudges are bot messages that
  //    themselves contain stage-triggering language ("share your
  //    name, address..."), so without this exclusion the cron
  //    treats each nudge as a fresh trigger and loops indefinitely.
  //    Live incident: bot spammed the same nudge every ~2min
  //    because nudge N spawned nudge N+1 as its own trigger.
  // ------------------------------------------------------------
  const { data: nudgeRows } = await db
    .from('conversation_close_nudges')
    .select('message_id')
    .gte('sent_at', staleCutoff.toISOString())
  const nudgeMessageIds = new Set(
    ((nudgeRows ?? []) as { message_id: string | null }[])
      .map((r) => r.message_id)
      .filter((id): id is string => Boolean(id)),
  )

  // ------------------------------------------------------------
  // 2. Fetch the most recent BOT text messages within the stale
  //    window. Over-fetches because we then per-row check that:
  //   * this message isn't itself a nudge we sent,
  //   * no newer customer message exists,
  //   * this bot message is the LATEST message in its
  //     conversation (i.e. no even-newer bot message either), and
  //   * the conversation itself is still AI-eligible.
  // ------------------------------------------------------------
  const { data: botMsgsRaw, error: botErr } = await db
    .from('messages')
    .select('id, conversation_id, content_text, created_at')
    .eq('sender_type', 'bot')
    .eq('content_type', 'text')
    .gte('created_at', staleCutoff.toISOString())
    .lt('created_at', new Date(now.getTime() - 60 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(batchSize * 4)
  if (botErr) {
    console.error('[close-nudge] bot msg query failed:', botErr)
    return NextResponse.json({ error: botErr.message }, { status: 500 })
  }
  const botMsgs = (botMsgsRaw ?? []) as RecentBotRow[]

  // De-dupe by conversation_id — first (newest) bot message per
  // conv wins; older ones are for stages that already passed.
  // Also SKIP any message that's a nudge we already sent (defense
  // against the self-trigger loop).
  const seenConvs = new Set<string>()
  const candidateBotMsgs: RecentBotRow[] = []
  for (const row of botMsgs) {
    if (nudgeMessageIds.has(row.id)) continue
    if (seenConvs.has(row.conversation_id)) continue
    seenConvs.add(row.conversation_id)
    candidateBotMsgs.push(row)
  }

  let sent = 0
  let skipped = 0
  const perStageSent: Record<string, number> = {}

  for (const bot of candidateBotMsgs) {
    if (sent >= batchSize) break
    const stage = detectCloseStage(bot.content_text)
    if (!stage) {
      skipped += 1
      continue
    }

    // Conversation gate: AI still on, thread open, contact not opted out.
    const { data: conv } = await db
      .from('conversations')
      .select('id, account_id, contact_id, ai_autoreply_disabled')
      .eq('id', bot.conversation_id)
      .maybeSingle()
    if (!conv) {
      skipped += 1
      continue
    }
    const c = conv as ConversationRow
    if (c.ai_autoreply_disabled) {
      skipped += 1
      continue
    }

    const { data: contact } = await db
      .from('contacts')
      .select('id, opted_out_at')
      .eq('id', c.contact_id)
      .maybeSingle()
    if (!contact || (contact as ContactRow).opted_out_at) {
      skipped += 1
      continue
    }

    // Is this bot message STILL the latest thing the customer saw
    // from us, with no reply? A newer customer inbound (fresh reply)
    // OR a newer bot/agent message (someone typed in the inbox)
    // means the stage moved on. Our OWN nudge for this thread does
    // NOT count as "moved on" — it is the follow-up to this very
    // message. (Before this exemption the second nudge of every
    // stage was unreachable: nudge 1 became the latest message and
    // failed this check forever — 13 first nudges, 0 second nudges
    // in the ledger as of 2026-09-20.) Nudges are never candidates
    // themselves (filtered above), and the per-stage cap plus the
    // 6h hard cap bound the count, so this can't re-open the loop.
    const { data: latest } = await db
      .from('messages')
      .select('id, sender_type, created_at')
      .eq('conversation_id', bot.conversation_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const latestId = (latest as { id: string } | null)?.id
    if (!latestId || (latestId !== bot.id && !nudgeMessageIds.has(latestId))) {
      skipped += 1
      continue
    }

    // Per-conversation HARD CAP (belt-and-braces). Regardless of
    // stage or which bot message triggered them, never send more
    // than CONVERSATION_MAX_NUDGES follow-ups to any one contact
    // inside any 6h window. Protects against future regex slips or
    // corrupted ledger rows re-triggering endlessly — as happened
    // once when the address-ask regex matched the nudge's own
    // paraphrase.
    const CONVERSATION_MAX_NUDGES = 3
    const capCutoff = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString()
    const { count: totalRecentNudges } = await db
      .from('conversation_close_nudges')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', c.id)
      .gte('sent_at', capCutoff)
    if ((totalRecentNudges ?? 0) >= CONVERSATION_MAX_NUDGES) {
      console.log(
        `[close-nudge] conv=${c.id} hit hard cap (${totalRecentNudges}/${CONVERSATION_MAX_NUDGES}) — skip`,
      )
      skipped += 1
      continue
    }

    // Per-triggering-bot-message stage cap (the primary counter —
    // 2 nudges per stage).
    const { data: nudgeRows } = await db
      .from('conversation_close_nudges')
      .select('nudge_number, sent_at')
      .eq('triggering_bot_message_id', bot.id)
      .eq('stage', stage)
      .order('sent_at', { ascending: true })
    const nudges = (nudgeRows ?? []) as { nudge_number: number; sent_at: string }[]
    const nextNudge = pickNextNudge(stage, nudges.length)
    if (!nextNudge) {
      skipped += 1
      continue
    }
    // Reference time for the next nudge: last nudge's sent_at (or
    // the bot message itself for the FIRST nudge). Fires when
    // minutesAfter minutes have elapsed since that reference.
    const referenceTime = new Date(
      nudges.length === 0
        ? bot.created_at
        : nudges[nudges.length - 1].sent_at,
    )
    const dueAt = new Date(
      referenceTime.getTime() + nextNudge.minutesAfter * 60 * 1000,
    )
    if (dueAt > now) {
      skipped += 1
      continue
    }

    try {
      const { whatsapp_message_id: _wa } = await engineSendText({
        accountId: c.account_id,
        userId: '',
        conversationId: c.id,
        contactId: c.contact_id,
        text: nextNudge.message,
        aiGenerated: true,
      })

      // Find the message row we just inserted so we can link it
      // in the nudge ledger. engineSendText writes with the same
      // whatsapp_message_id, so a targeted lookup is O(1).
      const { data: insertedMsg } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', c.id)
        .eq('sender_type', 'bot')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      await db.from('conversation_close_nudges').insert({
        conversation_id: c.id,
        account_id: c.account_id,
        stage,
        nudge_number: nextNudge.nudgeNumber,
        message_id: (insertedMsg as { id?: string } | null)?.id ?? null,
        triggering_bot_message_id: bot.id,
      })
      sent += 1
      perStageSent[stage] = (perStageSent[stage] ?? 0) + 1
      console.log(
        `[close-nudge] fired stage=${stage} n=${nextNudge.nudgeNumber} conv=${c.id}`,
      )
    } catch (err) {
      console.warn(
        `[close-nudge] send failed conv=${c.id} stage=${stage}:`,
        err instanceof Error ? err.message : err,
      )
      skipped += 1
    }
  }

  return NextResponse.json({
    candidates: candidateBotMsgs.length,
    sent,
    skipped,
    perStageSent,
    stages: Object.keys(STAGE_CONFIG),
  })
}
