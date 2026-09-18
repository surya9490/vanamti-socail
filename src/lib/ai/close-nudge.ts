// ============================================================
// Close-stage detection + nudge configuration.
//
// The cron identifies which "close-adjacent" stage (if any) the
// bot's last message left the conversation in, then picks a nudge
// message and cadence from the config below.
//
// Detection is regex-based on the bot's outgoing text. It has to
// be forgiving of the AI paraphrasing itself — the prompt
// encourages variation to avoid a robotic feel — so patterns key
// on the load-bearing words ("share your address", "confirm your
// order", "payment link"), not full-sentence matches.
// ============================================================

export type CloseStage =
  | 'catalog_sent'
  | 'address_ask'
  | 'address_confirm'
  | 'payment_link_sent'

interface StageConfig {
  /** Minute offsets after the bot's last message when each nudge
   *  should fire. Position i = nudge_number i+1. Max length also
   *  caps how many nudges we ever send for this stage. */
  nudgeMinutes: number[]
  /** One message per nudge_number. Position 0 → first nudge, 1 →
   *  second, etc. Length must match nudgeMinutes. */
  messages: string[]
}

export const STAGE_CONFIG: Record<CloseStage, StageConfig> = {
  // Bot sent the product catalog / listed products, customer
  // went quiet before picking anything. Prime moment for a sales
  // nudge — a real agent would gently probe interest and suggest
  // a starting point. Two varied messages so it doesn't feel
  // scripted: probe first, then a low-pressure recommendation.
  catalog_sent: {
    nudgeMinutes: [3, 10],
    messages: [
      'Take your time 🌿 If any of them caught your eye or you\'d like a suggestion, I\'m right here to help you pick.',
      'If you\'re still deciding — a great place to start is our A2 Cow Ghee (customer favourite 🍯). Or tell me what you\'re looking for and I\'ll point you to the right one.',
    ],
  },
  // Bot asked for the shipping address, customer went quiet
  // BEFORE sharing it. Two short warm nudges, 1 min then 3 min in.
  address_ask: {
    nudgeMinutes: [1, 3],
    messages: [
      'Still there? Ready when you are — just share your name, address, city, state, and pincode and I\'ll get this shipped 🌿',
      'No rush 🙏 Whenever you\'re ready, share your address and I\'ll create the payment link.',
    ],
  },
  // Bot showed the full delivery summary and asked "Ready to
  // create your payment link?". This is the CLOSEST moment to
  // conversion — nudge fast (1 min) then again 3 min later.
  address_confirm: {
    nudgeMinutes: [1, 3],
    messages: [
      'Just say "yes" if that looks right and I\'ll send you the payment link 🌿',
      'All good with the address? Let me know and I\'ll share the payment link 🍯',
    ],
  },
  // Payment link is out. Customer may be actually paying on
  // Shopify's checkout — don\'t nudge too fast; 3 min then 10 min.
  payment_link_sent: {
    nudgeMinutes: [3, 10],
    messages: [
      'Any trouble with the payment? Let me know if you need help — I\'m here 🙏',
      'Just checking in — the payment link\'s still active if you\'d like to complete it 🍯',
    ],
  },
}

// Case-insensitive matchers on the bot's content_text.
//
// address_confirm is checked BEFORE address_ask because a
// confirmation message often includes the words "address" and
// "pincode" too — the ORDER of checks disambiguates them.

// ONLY an actual checkout / invoice URL counts as "payment link
// sent". The bare phrase "payment link" doesn't — a confirmation
// message like "Ready to create your payment link?" mentions the
// phrase but is actually address_confirm, not payment_link_sent.
// Optional subdomain (`shop.vanamati.com`, `j7w7ue-0v.myshopify.com`
// or bare `vanamati.com`) and optional trailing slash — the
// draft-order URLs come back in both shapes depending on how
// Shopify serialises them.
const PAYMENT_LINK_RE =
  /https?:\/\/(?:[^\s/]+\.)?(?:vanamati|myshopify)\.com\/\d+\/(?:invoices|checkouts|carts)\/[^\s]+/i

const ADDRESS_CONFIRM_RE =
  /(confirm(?:ing)? your (?:full delivery |order|)|let me confirm your|ready (?:for me )?to (?:create|send) (?:your )?payment link)/i

// The AI prompt asks the model to collect "full name, address (line
// 1 + area), city, state, and 6-digit pincode". Require one of the
// DISTINCTIVE tokens ("full name" / "line 1" / "6-digit") to avoid
// false-matching our own nudges — the first nudge paraphrases as
// "share your name, address, city, state, and pincode", the second
// as "share your address" — neither uses those distinctive tokens,
// so they can't self-trigger even if the message_id de-dupe below
// somehow misses them.
const ADDRESS_ASK_RE =
  /(please share|share your|share:).{0,80}(full name|line ?1|6-digit)/i

// The bot's own follow-up text right after a catalog send —
// "Here's what we have at Vanamati — tap any product...", "Take a
// look at our range above...", "Here you go — tap any product...".
// Anti-loop: our catalog_sent nudges don't use "tap any product",
// "our range", or "at Vanamati", so they can't self-match.
const CATALOG_SENT_RE =
  /(tap any product|take a look at (?:our|the) (?:range|catalog|catalogue)|here'?s what we have|here you go[^\n]*tap)/i

// FOLLOW-UP clarifier — the customer gave a partial address and the
// AI is asking for a specific missing field ("what state?", "just
// need the pincode", "could you share your city"). Same stage as
// address_ask; nudge cadence + copy are identical.
//
// Anti-loop: none of our nudges use interrogatives ("what/which/
// need/can you/could you") — they're all declarative "still there?
// ...share...". So this regex can't match a nudge, keeping the
// address_ask counter from restarting on our own follow-ups.
const ADDRESS_CLARIFY_RE =
  /(what|which|need|(?:can|could) you).{0,60}(state|pincode|city|line ?1|6-digit)/i

/**
 * Identify which close stage the bot's most recent outgoing text
 * leaves the conversation in, or `null` if it isn't close-adjacent.
 *
 * Order matters: payment link first (most specific), then address
 * confirm (medium), then address ask (broadest).
 */
export function detectCloseStage(botText: string | null | undefined): CloseStage | null {
  if (!botText) return null
  const text = botText.trim()
  if (!text) return null

  if (PAYMENT_LINK_RE.test(text)) return 'payment_link_sent'
  if (ADDRESS_CONFIRM_RE.test(text)) return 'address_confirm'
  if (ADDRESS_ASK_RE.test(text)) return 'address_ask'
  if (ADDRESS_CLARIFY_RE.test(text)) return 'address_ask'
  // catalog_sent is the LEAST specific — check last so a bot text
  // that's both a catalog opener AND an address ask (rare) resolves
  // to the closer-to-close stage.
  if (CATALOG_SENT_RE.test(text)) return 'catalog_sent'
  return null
}

/**
 * Given the stage and how many nudges we've already sent for that
 * stage's triggering bot message, return the next nudge to send —
 * or `null` if we've hit the per-stage cap.
 */
export function pickNextNudge(
  stage: CloseStage,
  alreadySent: number,
): { minutesAfter: number; message: string; nudgeNumber: number } | null {
  const cfg = STAGE_CONFIG[stage]
  if (alreadySent >= cfg.nudgeMinutes.length) return null
  return {
    minutesAfter: cfg.nudgeMinutes[alreadySent],
    message: cfg.messages[alreadySent],
    nudgeNumber: alreadySent + 1,
  }
}
