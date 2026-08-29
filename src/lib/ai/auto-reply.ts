import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { getEnabledTools, type ToolContext } from './tools/registry'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    // Per-conversation cooldown: if we ai-replied to this conversation
    // within the last AI_REPLY_COOLDOWN_SECONDS, skip.
    //
    // Why: a customer sending "hi... hi... hi..." in the space of 5
    // seconds should trigger ONE reply, not three. The per-conversation
    // cap alone doesn't help — it counts total lifetime replies, not
    // burst rate. Without a cooldown the assistant reads three inbounds,
    // fires three near-identical replies, and the customer feels
    // spammed. With a cooldown, the first inbound triggers a reply; the
    // next two are absorbed and the reply the model eventually sends
    // (30s+ later, or when the customer says something substantially
    // new) has fuller context.
    //
    // 30s is picked empirically: short enough that a real question
    // gets a fresh reply almost immediately after the previous one
    // lands, long enough to catch typical rapid-typing bursts.
    // Hardcoded for now — promote to a per-account config field only
    // if tuning becomes a real need.
    const AI_REPLY_COOLDOWN_SECONDS = 30
    const cooldownCutoff = new Date(
      Date.now() - AI_REPLY_COOLDOWN_SECONDS * 1000,
    ).toISOString()
    const { data: recentAi } = await db
      .from('messages')
      .select('id, created_at')
      .eq('conversation_id', conversationId)
      .eq('ai_generated', true)
      .gt('created_at', cooldownCutoff)
      .limit(1)
    if (recentAi && recentAi.length > 0) {
      console.log(
        `[ai auto-reply] cooldown active on conversation ${conversationId} (last AI reply < ${AI_REPLY_COOLDOWN_SECONDS}s ago) — skipping.`,
      )
      return
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Silence-gap detection for re-engagement greeting.
    //
    // If the customer's previous inbound was >SILENCE_GAP_DAYS ago
    // (or there IS no previous inbound — this is their first message
    // in the conversation), treat this as a re-engagement moment: the
    // system prompt will instruct the model to greet + surface 1–3
    // products with prices from the KB.
    //
    // Why in-conversation gap and not cross-conversation: we want to
    // greet on "customer went quiet then came back", regardless of
    // whether prior conversations exist. A cold-open of a new
    // conversation is also re-engagement (they're returning to us).
    //
    // 3 days is picked as "long enough that a new greeting doesn't
    // feel weird in a normally-active thread". A same-day follow-up
    // should feel like a continuation, not a fresh hello. Hardcoded
    // for now — promote to config if a tuning need shows up.
    const SILENCE_GAP_DAYS = 3
    let silenceGapDays: number | null = null
    const { data: recentInbounds } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(2)
    if (recentInbounds && recentInbounds.length >= 1) {
      if (recentInbounds.length === 1) {
        // Only one customer message ever → this IS the first message.
        // Flagged as "gap of 0" is confusing; the prompt clause treats
        // any non-null value as "re-engagement".
        silenceGapDays = 0
      } else {
        const [current, previous] = recentInbounds
        const gapMs =
          new Date(current.created_at).getTime() -
          new Date(previous.created_at).getTime()
        const gapDays = gapMs / (1000 * 60 * 60 * 24)
        if (gapDays > SILENCE_GAP_DAYS) {
          silenceGapDays = Math.floor(gapDays)
        }
      }
    }

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      defaultLanguage: config.defaultLanguage,
      silenceGapDays,
    })

    // Function-calling tools the account has switched on (e.g. order
    // lookup). Only build the tool context — including one extra query for
    // the contact's phone — when at least one tool is actually enabled, so
    // the common no-tools path stays as cheap as before.
    const tools = getEnabledTools(config.enabledTools)
    let toolContext: ToolContext | undefined
    if (tools.length > 0) {
      const { data: toolContact } = await db
        .from('contacts')
        .select('phone')
        .eq('id', contactId)
        .eq('account_id', accountId)
        .maybeSingle()
      toolContext = {
        db,
        accountId,
        conversationId,
        contactId,
        contactPhone: (toolContact as { phone?: string } | null)?.phone ?? null,
      }
    }

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
      tools,
      toolContext,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
