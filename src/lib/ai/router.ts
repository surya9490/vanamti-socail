// ============================================================
// Model routing — pick a smaller/cheaper model for simple turns.
//
// Currently applied to Anthropic auto-reply only. Sonnet is the
// default (smart + capable of the sales-close flow, handoff
// decisions, tool orchestration). Haiku takes over ONLY when the
// turn is clearly a low-complexity chat turn — greetings, generic
// Q&A, browsing — where the extra reasoning of Sonnet is wasted.
//
// The router is intentionally conservative: when in doubt, use
// Sonnet. Wrong-way misroute (hard turn → Haiku) can fumble a
// draft-order call or miss a handoff signal; over-routing (easy
// turn → Sonnet) just costs a few extra ₹ we already know we can
// afford. So the bar for Haiku is "no way this could need the
// bigger model", not "probably fine".
//
// Env override for the fast model (Anthropic-only, defaults to
// Sonnet-5's smaller sibling): AI_FAST_MODEL_ANTHROPIC.
// ============================================================

import type { AiConfig } from './types'

const DEFAULT_FAST_MODEL_ANTHROPIC = 'claude-haiku-4-5-20251001'

/** Substrings that STRONGLY signal a hard turn — anything matching
 *  bumps the caller back to Sonnet. Case-insensitive substring
 *  match; deliberately liberal to over-route to Sonnet. */
const HARD_TURN_KEYWORDS = [
  // Order placement / close
  'address',
  'pincode',
  'pin code',
  'place order',
  'place my order',
  'place the order',
  'order for me',
  'confirm',
  'checkout',
  'pay',
  'payment',
  'delivery',
  'deliver',
  'ship to',
  // Handoff triggers
  'refund',
  'complaint',
  'complain',
  'cancel',
  'return',
  'human',
  'agent',
  'representative',
  'manager',
  'legal',
  'lawyer',
  'lawsuit',
  'sue',
  // Anger / frustration (partial list; the prompt evaluates the
  // full anger check on Sonnet if it gets there)
  'terrible',
  'worst',
  'scam',
  'fake',
  'fraud',
  'cheat',
  'awful',
  // Multi-language buying signals (short affirmatives get their own
  // check below — this list catches the multi-word variants)
  'haan bhai',
  'sure yes',
  'go ahead',
  'ok place',
  'kar do',
  'kar dijiye',
]

/** Short affirmatives — treated as CONFIRMATIONS in a sales close.
 *  When they appear standalone (short message), the previous turn
 *  probably asked a set-up question and this is the trigger to
 *  advance the flow (call create_draft_order). Sonnet needed. */
const SHORT_AFFIRMATIVES = new Set([
  'yes',
  'haan',
  'ha',
  'ok',
  'okay',
  'k',
  'sure',
  'please',
  'ji',
  'right',
  'correct',
  'confirmed',
  'confirm',
  '👍',
  '✅',
  'yep',
])

/**
 * Decide the model for the next auto-reply turn.
 *
 * @param args.config             the account's AI config (provider + default model)
 * @param args.latestUserMessage  the customer's most recent inbound text
 * @param args.hasCreateOrderTool whether create_draft_order is in the enabled tools list
 * @returns the model id to actually use; falls back to config.model
 *          for non-Anthropic providers or when the turn is complex
 */
export function pickModelForAutoReply(args: {
  config: Pick<AiConfig, 'provider' | 'model'>
  latestUserMessage: string
  hasCreateOrderTool: boolean
}): string {
  const { config, latestUserMessage, hasCreateOrderTool } = args

  // Routing is Anthropic-only for now. OpenAI + Gemini paths keep
  // their configured model — no per-provider fast model to route to.
  if (config.provider !== 'anthropic') return config.model

  const fastModel =
    process.env.AI_FAST_MODEL_ANTHROPIC || DEFAULT_FAST_MODEL_ANTHROPIC

  // Never route BACK to the fast model if the operator has already
  // set the fast model as the account default — they've opted in
  // to Haiku globally, we're not going to "upgrade" them to Sonnet.
  // This also handles the mirror-image case where a Haiku-only
  // account never gets routed at all.
  if (config.model === fastModel) return config.model

  const raw = (latestUserMessage ?? '').trim()

  // Empty / missing latest → default to the configured (bigger)
  // model since we have no signal.
  if (!raw) return config.model

  const lower = raw.toLowerCase()

  // Any hard-turn keyword → Sonnet
  for (const kw of HARD_TURN_KEYWORDS) {
    if (lower.includes(kw)) return config.model
  }

  // Short affirmative standalone message ("yes", "ok", "haan", 👍)
  // → the previous turn was almost certainly a set-up question and
  //   this is the trigger to advance a sales flow. Only routes when
  //   the tool is enabled — without it there's no draft to create,
  //   so a Haiku reply is safe.
  if (hasCreateOrderTool) {
    // Strip punctuation/whitespace so "yes." / "yes!" / "yes " all hit.
    const stripped = lower.replace(/[.,!?\s]/g, '')
    if (SHORT_AFFIRMATIVES.has(stripped)) return config.model
  }

  // Contains a 6-digit number → likely an Indian PIN code being
  // shared as part of an address → address parsing → Sonnet.
  if (/\b\d{6}\b/.test(raw)) return config.model

  // Long messages (>200 chars) → probably contain enough structure
  // to warrant the bigger model. Address blocks, multi-question
  // messages, complex intent — all fit this bucket.
  if (raw.length > 200) return config.model

  // Passed every hard-turn check → safe to use the fast model.
  return fastModel
}
