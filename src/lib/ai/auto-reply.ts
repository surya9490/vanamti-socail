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
import {
  postSlackNotification,
  buildHandoffSlackMessage,
} from '@/lib/notify/slack'
import { extractGrade, nextGrade, type LeadStage } from './grading'
import { mirrorLeadStageToTag } from '@/lib/contacts/lead-tag'
import { log, newTraceId } from '@/lib/log'
import { pickModelForAutoReply } from './router'

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
  const trace_id = newTraceId('ar')

  try {
    log.info('auto_reply.dispatched', {
      trace_id,
      account_id: accountId,
      conversation_id: conversationId,
      contact_id: contactId,
    })
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
    // Per-conversation reply cap removed per operator request: sales
    // conversations routinely need 5–10 turns to close (greet →
    // pick → confirm → address → link → follow-ups), and a hard
    // ceiling of 3 was killing threads mid-close. The 30-second
    // cooldown below still prevents rapid-fire loops; the master
    // switch (config.autoReplyEnabled) and the per-conversation
    // ai_autoreply_disabled flag remain as the kill switches.
    // ai_reply_count is still incremented after each send for
    // analytics.

    // (No post-reply cooldown here. There used to be a 30s cooldown
    // that skipped any inbound arriving within 30 seconds of our last
    // AI reply. That was designed for "hi hi hi hi" spam bursts, but
    // it wrongly blocked NORMAL conversation too — customer answers
    // our question within a few seconds ("here's my email") → cooldown
    // fires → their answer goes unanswered until they message again
    // much later, if ever. Bad UX and lost sales.
    //
    // Burst protection is now the batch-debounce below (waits
    // AI_MESSAGE_BATCH_WAIT_SECONDS for another inbound, then either
    // batches or lets the newer dispatch supersede this one).
    // That catches the "hi hi hi" case without silencing legitimate
    // follow-ups.)

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

    // Adaptive message-batch debounce.
    //
    // Trigger condition: only when the customer's PREVIOUS message
    // (recentInbounds[1], from the silence-gap query above) is
    // within QUICK_TYPING_WINDOW_MS of the current one — a typing
    // burst pattern where they're likely to send another fragment
    // in the next few seconds. Isolated messages (long gap since
    // the last customer message) get replied to immediately.
    //
    // When triggered, wait AI_MESSAGE_BATCH_WAIT_SECONDS then check
    // for a newer customer message. If a newer one arrived → this
    // dispatch is superseded, skip. If not → proceed to generate
    // a reply that covers the whole batch.
    //
    // Prior behavior added an 8s wait to EVERY reply, which felt
    // sluggish on straightforward back-and-forth exchanges (which
    // are 70% of turns). The adaptive version pays that latency
    // cost only when the pattern actually warrants it.
    const QUICK_TYPING_WINDOW_MS = 15_000
    const previousInbound = recentInbounds?.[1] // most recent BEFORE the current
    const inTypingBurst =
      previousInbound &&
      Date.now() - new Date(previousInbound.created_at).getTime() <
        QUICK_TYPING_WINDOW_MS

    if (inTypingBurst) {
      const batchWaitSecondsRaw = Number(
        process.env.AI_MESSAGE_BATCH_WAIT_SECONDS,
      )
      const batchWaitSeconds =
        Number.isFinite(batchWaitSecondsRaw) && batchWaitSecondsRaw >= 0
          ? batchWaitSecondsRaw
          : 6
      if (batchWaitSeconds > 0) {
        const debounceStartedAt = new Date().toISOString()
        await new Promise((r) => setTimeout(r, batchWaitSeconds * 1000))
        const { data: newerInbound } = await db
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('sender_type', 'customer')
          .gt('created_at', debounceStartedAt)
          .limit(1)
        if (newerInbound && newerInbound.length > 0) {
          log.info('auto_reply.skipped', {
            trace_id,
            reason: 'superseded_by_newer_inbound',
            debounce_seconds: batchWaitSeconds,
            conversation_id: conversationId,
          })
          return
        }
      }
    }

    // Per-contact daily token budget — guards against runaway spend
    // from a single (malicious / broken / bot) customer. Sums
    // total_tokens across ai_usage_log entries for this contact in
    // the last 24h; skips the reply if over.
    //
    // Default 20_000 tokens/contact/day (~50 replies) is enough for
    // any legitimate sales conversation and small enough that a
    // rogue looper is capped at ~₹1.5/day. Tunable via
    // AI_DAILY_TOKEN_BUDGET_PER_CONTACT. Set to 0 to disable
    // the check entirely.
    const budgetRaw = Number(process.env.AI_DAILY_TOKEN_BUDGET_PER_CONTACT)
    const dailyBudget =
      Number.isFinite(budgetRaw) && budgetRaw >= 0 ? budgetRaw : 20_000
    if (dailyBudget > 0) {
      const dayCutoff = new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ).toISOString()
      const { data: usageRows } = await db
        .from('ai_usage_log')
        .select('total_tokens')
        .eq('contact_id', contactId)
        .gt('created_at', dayCutoff)
      const spent =
        (usageRows as { total_tokens?: number }[] | null)?.reduce(
          (sum, r) => sum + (r.total_tokens ?? 0),
          0,
        ) ?? 0
      if (spent >= dailyBudget) {
        log.warn('auto_reply.skipped', {
          trace_id,
          reason: 'contact_token_budget_exceeded',
          contact_id: contactId,
          spent,
          budget: dailyBudget,
        })
        return
      }
    }

    // Account-wide throttle on the shared BYO key. This bounds a
    // burst across many threads (a marketing blast landing 200
    // replies at once) so we never run the owner's key past the
    // provider's rate limit. Over the limit → skip the auto-reply;
    // the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      log.warn('auto_reply.skipped', {
        trace_id,
        reason: 'account_rate_limit',
        account_id: accountId,
      })
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    // Pull the contact's name (if we have it) for light prompt
    // personalisation. Same query pattern used later for the tool
    // context / handoff notification — cheap; ~one indexed read.
    const { data: contactRowForPrompt } = await db
      .from('contacts')
      .select('name')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    const contactName =
      (contactRowForPrompt as { name?: string | null } | null)?.name ?? null

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      defaultLanguage: config.defaultLanguage,
      silenceGapDays,
      customerName: contactName,
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

    // Route to a cheaper/faster model on turns that clearly don't
    // need the bigger one (greetings, generic Q&A, browsing). The
    // router is conservative — anything with buying signals, an
    // address, a PIN code, handoff keywords, or a short affirmative
    // when the draft-order tool is enabled stays on the configured
    // (bigger) model. See src/lib/ai/router.ts for the full rules.
    const routedModel = pickModelForAutoReply({
      config,
      latestUserMessage: latestUserMessage(messages),
      hasCreateOrderTool: tools.some((t) => t.name === 'create_draft_order'),
    })
    const configForCall =
      routedModel === config.model ? config : { ...config, model: routedModel }

    const generated = await generateReply({
      config: configForCall,
      systemPrompt,
      messages,
      tools,
      toolContext,
    })
    const { handoff, usage } = generated

    // Extract the lead-grade tag emitted by the model at the END of
    // its reply (per the grading rubric in defaults.ts) and strip
    // it from the customer-facing text. On handoff turns the model
    // is instructed to emit only the sentinel, so grade is null.
    //
    // Grade parsing happens BEFORE the handoff branch so a handoff
    // reply that (against instructions) contains a grade tag still
    // gets the tag stripped before whatever comes next; the DB
    // update below is skipped when handoff=true.
    const { grade, text } = extractGrade(generated.text)

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      contactId,
      mode: 'auto_reply',
      provider: config.provider,
      // Record the ACTUALLY-used model, not the account default —
      // otherwise usage analytics would misreport spend across
      // Sonnet vs Haiku when the router downgrades a turn.
      model: routedModel,
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
      log.info('auto_reply.handed_off', {
        trace_id,
        conversation_id: conversationId,
        contact_id: contactId,
        assigned_agent_id: config.handoffAgentId ?? null,
      })

      // Slack notification — awaited, NOT fire-and-forget.
      //
      // We're already inside the webhook's after() block, so the
      // serverless container is being kept alive until this function
      // returns. Fire-and-forget (`void (async () => ...)()`) lets
      // the outer function return before the fetch finishes, at
      // which point the container can be frozen or killed on
      // Vercel/Railway and the POST is silently dropped.
      //
      // postSlackNotification enforces a 3s timeout and swallows all
      // errors, so awaiting adds at most ~500ms in the happy path
      // and can never fail the handoff. Silent no-op if
      // SLACK_WHATSAPP_ALERT_TEAM_WEBHOOK_URL is unset.
      try {
        const { data: contact } = await db
          .from('contacts')
          .select('name, phone')
          .eq('id', contactId)
          .maybeSingle()
        const lastCustomer = [...messages]
          .reverse()
          .find((m) => m.role === 'user')
        const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || '').replace(
          /\/+$/,
          '',
        )
        const inboxUrl = baseUrl
          ? `${baseUrl}/inbox?c=${conversationId}`
          : null
        await postSlackNotification(
          buildHandoffSlackMessage({
            contactName:
              (contact as { name?: string | null } | null)?.name ?? null,
            contactPhone:
              (contact as { phone?: string | null } | null)?.phone ?? null,
            lastCustomerMessage:
              typeof lastCustomer?.content === 'string'
                ? lastCustomer.content
                : null,
            handoffSummary: summary,
            inboxUrl,
          }),
        )
      } catch (err) {
        console.warn('[ai auto-reply] slack handoff notify failed:', err)
      }
      return
    }

    // Counter increment for analytics — no cap enforced (operator
    // removed the per-conversation cap; sales conversations need
    // 5–10 turns to close). Fire-and-forget: a failure here must
    // not block the send that the customer is waiting for.
    void db
      .from('conversations')
      .update({ ai_reply_count: (conv.ai_reply_count ?? 0) + 1 })
      .eq('id', conversationId)

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
    log.info('auto_reply.sent', {
      trace_id,
      conversation_id: conversationId,
      contact_id: contactId,
      model: routedModel,
      routed: routedModel !== config.model,
      text_length: text.length,
      grade: grade ?? null,
      tokens_prompt: usage?.promptTokens ?? null,
      tokens_completion: usage?.completionTokens ?? null,
    })

    // Ratchet the contact's lead_stage and mirror to the tag
    // system. Wrapped in try/catch and awaited (we're inside the
    // webhook's after() block, so serverless container is kept
    // alive) but a failure here must never affect the reply that
    // just went out. If the model didn't emit a grade tag,
    // `grade` is null and we skip.
    if (grade) {
      try {
        const { data: contactRow } = await db
          .from('contacts')
          .select('lead_stage')
          .eq('id', contactId)
          .eq('account_id', accountId)
          .maybeSingle()
        const currentStage =
          ((contactRow as { lead_stage?: string | null } | null)
            ?.lead_stage as LeadStage | null) ?? null
        const toWrite = nextGrade(currentStage, grade)
        if (toWrite) {
          const { error: updateErr } = await db
            .from('contacts')
            .update({
              lead_stage: toWrite,
              lead_stage_updated_at: new Date().toISOString(),
            })
            .eq('id', contactId)
            .eq('account_id', accountId)
          if (updateErr) {
            console.warn('[ai auto-reply] lead_stage update failed:', updateErr)
          } else {
            await mirrorLeadStageToTag(db, accountId, contactId, toWrite)
          }
        }
      } catch (err) {
        console.warn('[ai auto-reply] grading step failed:', err)
      }
    }
  } catch (err) {
    log.error('auto_reply.dispatch_failed', {
      trace_id,
      account_id: accountId,
      conversation_id: conversationId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
